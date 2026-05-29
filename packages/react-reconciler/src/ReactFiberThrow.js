/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import type {CapturedValue} from './ReactCapturedValue';
import type {Update} from './ReactFiberClassUpdateQueue';
import type {Wakeable} from 'shared/ReactTypes';
import type {
  OffscreenQueue,
  OffscreenState,
} from './ReactFiberOffscreenComponent';
import type {RetryQueue} from './ReactFiberSuspenseComponent';

import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import {
  ClassComponent,
  HostRoot,
  IncompleteClassComponent,
  IncompleteFunctionComponent,
  FunctionComponent,
  ForwardRef,
  SimpleMemoComponent,
  ActivityComponent,
  SuspenseComponent,
  OffscreenComponent,
  SuspenseListComponent,
} from './ReactWorkTags';
import {
  DidCapture,
  Incomplete,
  NoFlags,
  ShouldCapture,
  LifecycleEffectMask,
  ForceUpdateForLegacySuspense,
  ForceClientRender,
  ScheduleRetry,
} from './ReactFiberFlags';
import {NoMode, ConcurrentMode} from './ReactTypeOfMode';
import {
  enableUpdaterTracking,
  disableLegacyMode,
} from 'shared/ReactFeatureFlags';
import {createCapturedValueAtFiber} from './ReactCapturedValue';
import {
  enqueueCapturedUpdate,
  createUpdate,
  CaptureUpdate,
  ForceUpdate,
  enqueueUpdate,
} from './ReactFiberClassUpdateQueue';
import {markFailedErrorBoundaryForHotReloading} from './ReactFiberHotReloading';
import {
  getShellBoundary,
  getSuspenseHandler,
} from './ReactFiberSuspenseContext';
import {
  renderDidError,
  queueConcurrentError,
  renderDidSuspendDelayIfPossible,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  attachPingListener,
  restorePendingUpdaters,
  renderDidSuspend,
} from './ReactFiberWorkLoop';
import {propagateParentContextChangesToDeferredTree} from './ReactFiberNewContext';
import {logUncaughtError, logCaughtError} from './ReactFiberErrorLogger';
import {isDevToolsPresent} from './ReactFiberDevToolsHook';
import {
  SyncLane,
  includesSomeLane,
  mergeLanes,
  pickArbitraryLane,
} from './ReactFiberLane';
import {
  getIsHydrating,
  markDidThrowWhileHydratingDEV,
  queueHydrationError,
  HydrationMismatchException,
} from './ReactFiberHydrationContext';
import {ConcurrentRoot} from './ReactRootTags';
import {noopSuspenseyCommitThenable} from './ReactFiberThenable';
import {runWithFiberInDEV} from './ReactCurrentFiber';
import {callComponentDidCatchInDEV} from './ReactFiberCallUserSpace';

function createRootErrorUpdate(
  root: FiberRoot,
  errorInfo: CapturedValue<mixed>,
  lane: Lane,
): Update<mixed> {
  const update = createUpdate(lane);
  // Unmount the root by rendering null.
  update.tag = CaptureUpdate;
  // Caution: React DevTools currently depends on this property
  // being called "element".
  update.payload = {element: null};
  update.callback = () => {
    if (__DEV__) {
      runWithFiberInDEV(errorInfo.source, logUncaughtError, root, errorInfo);
    } else {
      logUncaughtError(root, errorInfo);
    }
  };
  return update;
}

function createClassErrorUpdate(lane: Lane): Update<mixed> {
  const update = createUpdate(lane);
  update.tag = CaptureUpdate;
  return update;
}

function initializeClassErrorUpdate(
  update: Update<mixed>,
  root: FiberRoot,
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
): void {
  const getDerivedStateFromError = fiber.type.getDerivedStateFromError;
  if (typeof getDerivedStateFromError === 'function') {
    const error = errorInfo.value;
    update.payload = () => {
      return getDerivedStateFromError(error);
    };
    update.callback = () => {
      if (__DEV__) {
        markFailedErrorBoundaryForHotReloading(fiber);
      }
      if (__DEV__) {
        runWithFiberInDEV(
          errorInfo.source,
          logCaughtError,
          root,
          fiber,
          errorInfo,
        );
      } else {
        logCaughtError(root, fiber, errorInfo);
      }
    };
  }

  const inst = fiber.stateNode;
  if (inst !== null && typeof inst.componentDidCatch === 'function') {
    // $FlowFixMe[missing-this-annot]
    update.callback = function callback() {
      if (__DEV__) {
        markFailedErrorBoundaryForHotReloading(fiber);
      }
      if (__DEV__) {
        runWithFiberInDEV(
          errorInfo.source,
          logCaughtError,
          root,
          fiber,
          errorInfo,
        );
      } else {
        logCaughtError(root, fiber, errorInfo);
      }
      if (typeof getDerivedStateFromError !== 'function') {
        // To preserve the preexisting retry behavior of error boundaries,
        // we keep track of which ones already failed during this batch.
        // This gets reset before we yield back to the browser.
        // TODO: Warn in strict mode if getDerivedStateFromError is
        // not defined.
        markLegacyErrorBoundaryAsFailed(this);
      }
      if (__DEV__) {
        callComponentDidCatchInDEV(this, errorInfo);
      } else {
        const error = errorInfo.value;
        const stack = errorInfo.stack;
        this.componentDidCatch(error, {
          componentStack: stack !== null ? stack : '',
        });
      }
      if (__DEV__) {
        if (typeof getDerivedStateFromError !== 'function') {
          // If componentDidCatch is the only error boundary method defined,
          // then it needs to call setState to recover from errors.
          // If no state update is scheduled then the boundary will swallow the error.
          if (!includesSomeLane(fiber.lanes, (SyncLane: Lane))) {
            console.error(
              '%s: Error boundaries should implement getDerivedStateFromError(). ' +
                'In that method, return a state update to display an error message or fallback UI.',
              getComponentNameFromFiber(fiber) || 'Unknown',
            );
          }
        }
      }
    };
  }
}

function resetSuspendedComponent(sourceFiber: Fiber, rootRenderLanes: Lanes) {
  const currentSourceFiber = sourceFiber.alternate;
  if (currentSourceFiber !== null) {
    // Since we never visited the children of the suspended component, we
    // need to propagate the context change now, to ensure that we visit
    // them during the retry.
    //
    // We don't have to do this for errors because we retry errors without
    // committing in between. So this is specific to Suspense.
    propagateParentContextChangesToDeferredTree(
      currentSourceFiber,
      sourceFiber,
      rootRenderLanes,
    );
  }

  // Reset the memoizedState to what it was before we attempted to render it.
  // A legacy mode Suspense quirk, only relevant to hook components.
  const tag = sourceFiber.tag;
  if (
    !disableLegacyMode &&
    (sourceFiber.mode & ConcurrentMode) === NoMode &&
    (tag === FunctionComponent ||
      tag === ForwardRef ||
      tag === SimpleMemoComponent)
  ) {
    const currentSource = sourceFiber.alternate;
    if (currentSource) {
      sourceFiber.updateQueue = currentSource.updateQueue;
      sourceFiber.memoizedState = currentSource.memoizedState;
      sourceFiber.lanes = currentSource.lanes;
    } else {
      sourceFiber.updateQueue = null;
      sourceFiber.memoizedState = null;
    }
  }
}

function markSuspenseBoundaryShouldCapture(
  suspenseBoundary: Fiber,
  returnFiber: Fiber | null,
  sourceFiber: Fiber,
  root: FiberRoot,
  rootRenderLanes: Lanes,
): Fiber | null {
  // This marks a Suspense boundary so that when we're unwinding the stack,
  // it captures the suspended "exception" and does a second (fallback) pass.
  if (
    !disableLegacyMode &&
    (suspenseBoundary.mode & ConcurrentMode) === NoMode
  ) {
    // Legacy Mode Suspense
    //
    // If the boundary is in legacy mode, we should *not*
    // suspend the commit. Pretend as if the suspended component rendered
    // null and keep rendering. When the Suspense boundary completes,
    // we'll do a second pass to render the fallback.
    if (suspenseBoundary === returnFiber) {
      // Special case where we suspended while reconciling the children of
      // a Suspense boundary's inner Offscreen wrapper fiber. This happens
      // when a React.lazy component is a direct child of a
      // Suspense boundary.
      //
      // Suspense boundaries are implemented as multiple fibers, but they
      // are a single conceptual unit. The legacy mode behavior where we
      // pretend the suspended fiber committed as `null` won't work,
      // because in this case the "suspended" fiber is the inner
      // Offscreen wrapper.
      //
      // Because the contents of the boundary haven't started rendering
      // yet (i.e. nothing in the tree has partially rendered) we can
      // switch to the regular, concurrent mode behavior: mark the
      // boundary with ShouldCapture and enter the unwind phase.
      suspenseBoundary.flags |= ShouldCapture;
    } else {
      suspenseBoundary.flags |= DidCapture;
      sourceFiber.flags |= ForceUpdateForLegacySuspense;

      // We're going to commit this fiber even though it didn't complete.
      // But we shouldn't call any lifecycle methods or callbacks. Remove
      // all lifecycle effect tags.
      sourceFiber.flags &= ~(LifecycleEffectMask | Incomplete);

      if (sourceFiber.tag === ClassComponent) {
        const currentSourceFiber = sourceFiber.alternate;
        if (currentSourceFiber === null) {
          // This is a new mount. Change the tag so it's not mistaken for a
          // completed class component. For example, we should not call
          // componentWillUnmount if it is deleted.
          sourceFiber.tag = IncompleteClassComponent;
        } else {
          // When we try rendering again, we should not reuse the current fiber,
          // since it's known to be in an inconsistent state. Use a force update to
          // prevent a bail out.
          const update = createUpdate(SyncLane);
          update.tag = ForceUpdate;
          enqueueUpdate(sourceFiber, update, SyncLane);
        }
      } else if (sourceFiber.tag === FunctionComponent) {
        const currentSourceFiber = sourceFiber.alternate;
        if (currentSourceFiber === null) {
          // This is a new mount. Change the tag so it's not mistaken for a
          // completed function component.
          sourceFiber.tag = IncompleteFunctionComponent;
        }
      }

      // The source fiber did not complete. Mark it with Sync priority to
      // indicate that it still has pending work.
      sourceFiber.lanes = mergeLanes(sourceFiber.lanes, SyncLane);
    }
    return suspenseBoundary;
  }
  // Confirmed that the boundary is in a concurrent mode tree. Continue
  // with the normal suspend path.
  //
  // After this we'll use a set of heuristics to determine whether this
  // render pass will run to completion or restart or "suspend" the commit.
  // The actual logic for this is spread out in different places.
  //
  // This first principle is that if we're going to suspend when we complete
  // a root, then we should also restart if we get an update or ping that
  // might unsuspend it, and vice versa. The only reason to suspend is
  // because you think you might want to restart before committing. However,
  // it doesn't make sense to restart only while in the period we're suspended.
  //
  // Restarting too aggressively is also not good because it starves out any
  // intermediate loading state. So we use heuristics to determine when.

  // Suspense Heuristics
  //
  // If nothing threw a Promise or all the same fallbacks are already showing,
  // then don't suspend/restart.
  //
  // If this is an initial render of a new tree of Suspense boundaries and
  // those trigger a fallback, then don't suspend/restart. We want to ensure
  // that we can show the initial loading state as quickly as possible.
  //
  // If we hit a "Delayed" case, such as when we'd switch from content back into
  // a fallback, then we should always suspend/restart. Transitions apply
  // to this case. If none is defined, JND is used instead.
  //
  // If we're already showing a fallback and it gets "retried", allowing us to show
  // another level, but there's still an inner boundary that would show a fallback,
  // then we suspend/restart for 500ms since the last time we showed a fallback
  // anywhere in the tree. This effectively throttles progressive loading into a
  // consistent train of commits. This also gives us an opportunity to restart to
  // get to the completed state slightly earlier.
  //
  // If there's ambiguity due to batching it's resolved in preference of:
  // 1) "delayed", 2) "initial render", 3) "retry".
  //
  // We want to ensure that a "busy" state doesn't get force committed. We want to
  // ensure that new initial loading states can commit as soon as possible.
  suspenseBoundary.flags |= ShouldCapture;
  // TODO: I think we can remove this, since we now use `DidCapture` in
  // the begin phase to prevent an early bailout.
  suspenseBoundary.lanes = rootRenderLanes;
  return suspenseBoundary;
}

/**
 * 处理渲染阶段的异常和 Suspense
 * @param {*} root fiber root 节点
 * @param {*} returnFiber 父节点
 * @param {*} sourceFiber 抛出异常的节点
 * @param {*} value 异常值 （promise、error)
 * @param {*} rootRenderLanes  根渲染车道
 * @returns 
 */
function throwException(
  root: FiberRoot,
  returnFiber: Fiber | null,
  sourceFiber: Fiber,
  value: mixed,
  rootRenderLanes: Lanes,
): boolean {
  // The source fiber did not complete.
  sourceFiber.flags |= Incomplete; // 标记为不完成

  if (enableUpdaterTracking) {
    if (isDevToolsPresent) {
      // If we have pending work still, restore the original updaters
      restorePendingUpdaters(root, rootRenderLanes);
    }
  }

  if (value !== null && typeof value === 'object') {
    // 处理 Suspense（Promise/thenable） 
    if (typeof value.then === 'function') {
      // This is a wakeable. The component suspended.
      const wakeable: Wakeable = (value: any);
      resetSuspendedComponent(sourceFiber, rootRenderLanes);

      // if (__DEV__) {
      //   if (
      //     getIsHydrating() &&
      //     (disableLegacyMode || sourceFiber.mode & ConcurrentMode)
      //   ) {
      //     markDidThrowWhileHydratingDEV();
      //   }
      // }

      // Mark the nearest Suspense boundary to switch to rendering a fallback.
      // 找到 Suspense 边界       
      const suspenseBoundary = getSuspenseHandler();
      if (suspenseBoundary !== null) {
        switch (suspenseBoundary.tag) {
          case ActivityComponent:// 31
          case SuspenseComponent: // 13
          case SuspenseListComponent: { // 19
            // 将挂起的 Promise 与边界关联起来，并标记该边界需要显示 fallback
            // React 会沿着父链向上查找最近的“边界”组件，这些边界可以是：
            // <Suspense> 组件（SuspenseComponent）
            // <Activity mode="hidden"> 组件（ActivityComponent）
            // <SuspenseList> 组件（SuspenseListComponent，实验性）

            if (disableLegacyMode || sourceFiber.mode & ConcurrentMode) {

              // 判断当前边界是否是“Shell”边界（最外层没有父 Suspense 的边界）
              if (getShellBoundary() === null) {
                // Suspended in the "shell" of the app. This is an undesirable
                // loading state. We should avoid committing this tree.
                // 挂起发生在 Shell 中，并且没有 fallback，可能导致整个应用空白
                // 调用 renderDidSuspendDelayIfPossible 延迟提交，给数据加载一点时间
                renderDidSuspendDelayIfPossible();
              } else {
                const current = suspenseBoundary.alternate;
                if (current === null) {
                  // 该边界是首次渲染时挂起，标记正常挂起（会显示 fallback）
                  renderDidSuspend();
                }
              }
            }

            // 清除可能遗留的强制客户端渲染标记
            suspenseBoundary.flags &= ~ForceClientRender; // 256
            // 标记该边界需要捕获挂起（即将渲染 fallback）
            markSuspenseBoundaryShouldCapture(
              suspenseBoundary,
              returnFiber,
              sourceFiber,
              root,
              rootRenderLanes,
            );
            // 判断抛出的 Promise 是否是“Suspensey 资源”（例如字体、图片加载产生的特殊 thenable）
            const isSuspenseyResource =
              wakeable === noopSuspenseyCommitThenable;
            if (isSuspenseyResource) {
              // 对于资源类型的挂起，直接标记 ScheduleRetry，表示需要立即重试（通常不需要等待 ping）
              suspenseBoundary.flags |= ScheduleRetry; // 16384
            } else {
               // 普通 Promise（动态导入、数据请求）：
               // 将 thenable 加入边界的重试队列（updateQueue）
              const retryQueue: RetryQueue | null =
                (suspenseBoundary.updateQueue: any);
              if (retryQueue === null) {
                suspenseBoundary.updateQueue = new Set([wakeable]);
              } else {
                retryQueue.add(wakeable);
              }

              // We only attach ping listeners in concurrent mode. Legacy
              // Suspense always commits fallbacks synchronously, so there are
              // no pings.
              if (disableLegacyMode || suspenseBoundary.mode & ConcurrentMode) {
                //  在并发模式下，为 Promise 附加 ping 监听器（当 Promise resolve 时重新调度边界）
                attachPingListener(root, wakeable, rootRenderLanes);
              }
            }
            // 返回 false 表示没有发生致命错误
            return false;
          }
          case OffscreenComponent: {
            if (disableLegacyMode || suspenseBoundary.mode & ConcurrentMode) {
              suspenseBoundary.flags |= ShouldCapture;
              const isSuspenseyResource =
                wakeable === noopSuspenseyCommitThenable;
              if (isSuspenseyResource) {
                suspenseBoundary.flags |= ScheduleRetry;
              } else {
                const offscreenQueue: OffscreenQueue | null =
                  (suspenseBoundary.updateQueue: any);
                if (offscreenQueue === null) {
                  const newOffscreenQueue: OffscreenQueue = {
                    transitions: null,
                    markerInstances: null,
                    retryQueue: new Set([wakeable]),
                  };
                  suspenseBoundary.updateQueue = newOffscreenQueue;
                } else {
                  const retryQueue = offscreenQueue.retryQueue;
                  if (retryQueue === null) {
                    offscreenQueue.retryQueue = new Set([wakeable]);
                  } else {
                    retryQueue.add(wakeable);
                  }
                }

                attachPingListener(root, wakeable, rootRenderLanes);
              }
              return false;
            }
          }
        }
        throw new Error(
          `Unexpected Suspense handler tag (${suspenseBoundary.tag}). This ` +
            'is a bug in React.',
        );
      } else {
        // No boundary was found. Unless this is a sync update, this is OK.
        // We can suspend and wait for more data to arrive.

        if (disableLegacyMode || root.tag === ConcurrentRoot) {
          // In a concurrent root, suspending without a Suspense boundary is
          // allowed. It will suspend indefinitely without committing.
          //
          // TODO: Should we have different behavior for discrete updates? What
          // about flushSync? Maybe it should put the tree into an inert state,
          // and potentially log a warning. Revisit this for a future release.
          attachPingListener(root, wakeable, rootRenderLanes);
          renderDidSuspendDelayIfPossible();
          return false;
        } else {
          // In a legacy root, suspending without a boundary is always an error.
          const uncaughtSuspenseError = new Error(
            'A component suspended while responding to synchronous input. This ' +
              'will cause the UI to be replaced with a loading indicator. To ' +
              'fix, updates that suspend should be wrapped ' +
              'with startTransition.',
          );
          value = uncaughtSuspenseError;
        }
      }
    }
  }

  // This is a regular error, not a Suspense wakeable.
  if (
    getIsHydrating() &&
    (disableLegacyMode || sourceFiber.mode & ConcurrentMode)
  ) {
    markDidThrowWhileHydratingDEV();
    const hydrationBoundary = getSuspenseHandler();
    // If the error was thrown during hydration, we may be able to recover by
    // discarding the dehydrated content and switching to a client render.
    // Instead of surfacing the error, find the nearest Suspense boundary
    // and render it again without hydration.
    if (hydrationBoundary !== null) {
      if (__DEV__) {
        if (hydrationBoundary.tag === SuspenseListComponent) {
          console.error(
            'SuspenseList should never catch while hydrating. This is a bug in React.',
          );
        }
      }
      if ((hydrationBoundary.flags & ShouldCapture) === NoFlags) {
        // Set a flag to indicate that we should try rendering the normal
        // children again, not the fallback.
        hydrationBoundary.flags |= ForceClientRender;
      }
      markSuspenseBoundaryShouldCapture(
        hydrationBoundary,
        returnFiber,
        sourceFiber,
        root,
        rootRenderLanes,
      );

      // Even though the user may not be affected by this error, we should
      // still log it so it can be fixed.
      if (value !== HydrationMismatchException) {
        const wrapperError = new Error(
          'There was an error while hydrating but React was able to recover by ' +
            'instead client rendering from the nearest Suspense boundary.',
          {cause: value},
        );
        queueHydrationError(
          createCapturedValueAtFiber(wrapperError, sourceFiber),
        );
      }
      return false;
    } else {
      if (value !== HydrationMismatchException) {
        const wrapperError = new Error(
          'There was an error while hydrating but React was able to recover by ' +
            'instead client rendering the entire root.',
          {cause: value},
        );
        queueHydrationError(
          createCapturedValueAtFiber(wrapperError, sourceFiber),
        );
      }
      const workInProgress: Fiber = (root.current: any).alternate;
      // Schedule an update at the root to log the error but this shouldn't
      // actually happen because we should recover.
      workInProgress.flags |= ShouldCapture;
      const lane = pickArbitraryLane(rootRenderLanes);
      workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
      const rootErrorInfo = createCapturedValueAtFiber(value, sourceFiber);
      const update = createRootErrorUpdate(
        workInProgress.stateNode,
        rootErrorInfo, // This should never actually get logged due to the recovery.
        lane,
      );
      enqueueCapturedUpdate(workInProgress, update);
      renderDidError();
      return false;
    }
  } else {
    // Otherwise, fall through to the error path.
  }

  const wrapperError = new Error(
    'There was an error during concurrent rendering but React was able to recover by ' +
      'instead synchronously rendering the entire root.',
    {cause: value},
  );
  queueConcurrentError(createCapturedValueAtFiber(wrapperError, sourceFiber));
  renderDidError();

  // We didn't find a boundary that could handle this type of exception. Start
  // over and traverse parent path again, this time treating the exception
  // as an error.

  if (returnFiber === null) {
    // There's no return fiber, which means the root errored. This should never
    // happen. Return `true` to trigger a fatal error (panic).
    return true;
  }

  const errorInfo = createCapturedValueAtFiber(value, sourceFiber);
  let workInProgress: Fiber = returnFiber;
  do {
    switch (workInProgress.tag) {
      case HostRoot: {
        workInProgress.flags |= ShouldCapture;
        const lane = pickArbitraryLane(rootRenderLanes);
        workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
        const update = createRootErrorUpdate(
          workInProgress.stateNode,
          errorInfo,
          lane,
        );
        enqueueCapturedUpdate(workInProgress, update);
        return false;
      }
      case ClassComponent:
        // Capture and retry
        const ctor = workInProgress.type;
        const instance = workInProgress.stateNode;
        if (
          (workInProgress.flags & DidCapture) === NoFlags &&
          (typeof ctor.getDerivedStateFromError === 'function' ||
            (instance !== null &&
              typeof instance.componentDidCatch === 'function' &&
              !isAlreadyFailedLegacyErrorBoundary(instance)))
        ) {
          workInProgress.flags |= ShouldCapture;
          const lane = pickArbitraryLane(rootRenderLanes);
          workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
          // Schedule the error boundary to re-render using updated state
          const update = createClassErrorUpdate(lane);
          initializeClassErrorUpdate(update, root, workInProgress, errorInfo);
          enqueueCapturedUpdate(workInProgress, update);
          return false;
        }
        break;
      case OffscreenComponent: {
        const offscreenState: OffscreenState | null =
          (workInProgress.memoizedState: any);
        if (offscreenState !== null) {
          // An error was thrown inside a hidden Offscreen boundary. This should
          // not be allowed to escape into the visible part of the UI. Mark the
          // boundary with ShouldCapture to abort the ongoing prerendering
          // attempt. This is the same flag would be set if something were to
          // suspend. It will be cleared the next time the boundary
          // is attempted.
          workInProgress.flags |= ShouldCapture;
          return false;
        }
        break;
      }
      default:
        break;
    }
    // $FlowFixMe[incompatible-type] we bail out when we get a null
    workInProgress = workInProgress.return;
  } while (workInProgress !== null);

  return false;
}

export {
  throwException,
  createRootErrorUpdate,
  createClassErrorUpdate,
  initializeClassErrorUpdate,
};
