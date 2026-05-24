/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import type {PriorityLevel} from 'scheduler/src/SchedulerPriorities';
import type {Transition} from 'react/src/ReactStartTransition';

import {
  disableLegacyMode,
  disableSchedulerTimeoutInWorkLoop,
  enableProfilerTimer,
  enableProfilerNestedUpdatePhase,
  enableComponentPerformanceTrack,
  enableYieldingBeforePassive,
  enableGestureTransition,
  enableDefaultTransitionIndicator,
} from 'shared/ReactFeatureFlags';
import {
  NoLane,
  NoLanes,
  SyncLane,
  DefaultLane,
  getHighestPriorityLane,
  getNextLanes,
  includesSyncLane,
  markStarvedLanesAsExpired,
  claimNextTransitionUpdateLane,
  getNextLanesToFlushSync,
  checkIfRootIsPrerendering,
  isGestureRender,
} from './ReactFiberLane';
import {
  CommitContext,
  NoContext,
  RenderContext,
  flushPendingEffects,
  flushPendingEffectsDelayed,
  getExecutionContext,
  getWorkInProgressRoot,
  getWorkInProgressRootRenderLanes,
  getRootWithPendingPassiveEffects,
  getPendingPassiveEffectsLanes,
  hasPendingCommitEffects,
  isWorkLoopSuspendedOnData,
  performWorkOnRoot,
} from './ReactFiberWorkLoop';
import {LegacyRoot} from './ReactRootTags';
import {
  ImmediatePriority as ImmediateSchedulerPriority,
  UserBlockingPriority as UserBlockingSchedulerPriority,
  NormalPriority as NormalSchedulerPriority,
  IdlePriority as IdleSchedulerPriority,
  cancelCallback as Scheduler_cancelCallback,
  scheduleCallback as Scheduler_scheduleCallback,
  now,
} from './Scheduler';
import {
  DiscreteEventPriority,
  ContinuousEventPriority,
  DefaultEventPriority,
  IdleEventPriority,
  lanesToEventPriority,
} from './ReactEventPriorities';
import {
  supportsMicrotasks,
  scheduleMicrotask,
  shouldAttemptEagerTransition,
  trackSchedulerEvent,
  noTimeout,
} from './ReactFiberConfig';

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {
  resetNestedUpdateFlag,
  syncNestedUpdateFlag,
} from './ReactProfilerTimer';
import {peekEntangledActionLane} from './ReactFiberAsyncAction';

import noop from 'shared/noop';
import reportGlobalError from 'shared/reportGlobalError';

import {
  startIsomorphicDefaultIndicatorIfNeeded,
  hasOngoingIsomorphicIndicator,
  retainIsomorphicIndicator,
  markIsomorphicIndicatorHandled,
} from './ReactFiberAsyncAction';

// A linked list of all the roots with pending work. In an idiomatic app,
// there's only a single root, but we do support multi root apps, hence this
// extra complexity. But this module is optimized for the single root case.
export let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

// Used to prevent redundant mircotasks from being scheduled.
let didScheduleMicrotask: boolean = false;
// `act` "microtasks" are scheduled on the `act` queue instead of an actual
// microtask, so we have to dedupe those separately. This wouldn't be an issue
// if we required all `act` calls to be awaited, which we might in the future.
let didScheduleMicrotask_act: boolean = false;

// Used to quickly bail out of flushSync if there's no sync work to do.
let mightHavePendingSyncWork: boolean = false;

let isFlushingWork: boolean = false;

let currentEventTransitionLane: Lane = NoLane;

/**
 *  React 调度系统的关键函数，负责确保 FiberRoot 被添加到调度列表并触发调度任务
 * @param {*} root 
 */
export function ensureRootIsScheduled(root: FiberRoot): void {
  // This function is called whenever a root receives an update. It does two
  // things 1) it ensures the root is in the root schedule, and 2) it ensures
  // there's a pending microtask to process the root schedule.
  //
  // Most of the actual scheduling logic does not happen until
  // `scheduleTaskForRootDuringMicrotask` runs.

  // Add the root to the schedule
  // 检查 root 是否已调度，避免重复添加到调度列表
  if (root === lastScheduledRoot || root.next !== null) {
    // Fast path. This root is already scheduled.
  } else {
    // 添加到调度链表末尾
    if (lastScheduledRoot === null) {
      firstScheduledRoot = lastScheduledRoot = root;
    } else {
      lastScheduledRoot.next = root;
      lastScheduledRoot = root;
    }
  }

  // Any time a root received an update, we set this to true until the next time
  // we process the schedule. If it's false, then we can quickly exit flushSync
  // without consulting the schedule.
  mightHavePendingSyncWork = true; // 标记可能有同步工作

  // 确保调度任务被安排，触发渲染流程
  ensureScheduleIsScheduled();

  // Legacy Mode 特殊处理
  if (
    __DEV__ &&
    !disableLegacyMode &&
    ReactSharedInternals.isBatchingLegacy &&
    root.tag === LegacyRoot
  ) {
    // Special `act` case: Record whenever a legacy update is scheduled.
    ReactSharedInternals.didScheduleLegacyUpdate = true;
  }
}

/**
 * React 调度系统的关键函数，负责确保调度任务被正确安排到微任务队列中
 */
export function ensureScheduleIsScheduled(): void {
  // At the end of the current event, go through each of the roots and ensure
  // there's a task scheduled for each one at the correct priority.
  // 检查是否在 act 测试环境
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // We're inside an `act` scope.
    if (!didScheduleMicrotask_act) {
      didScheduleMicrotask_act = true; // 使用 didScheduleMicrotask_act 标记
      scheduleImmediateRootScheduleTask();
    }
  } else {
    if (!didScheduleMicrotask) {
      didScheduleMicrotask = true; // 标记已调度
      // 触发调度任务
      scheduleImmediateRootScheduleTask();
    }
  }
}

export function flushSyncWorkOnAllRoots() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  flushSyncWorkAcrossRoots_impl(NoLanes, false);
}

export function flushSyncWorkOnLegacyRootsOnly() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  if (!disableLegacyMode) {
    flushSyncWorkAcrossRoots_impl(NoLanes, true);
  }
}

/**
 * 同步刷新所有根节点的同步工作
 * @param {*} syncTransitionLanes 
 * @param {*} onlyLegacy 
 * @returns 
 */
function flushSyncWorkAcrossRoots_impl(
  syncTransitionLanes: Lanes | Lane,
  onlyLegacy: boolean,
) {
  // 检查是否正在刷新（防止重入）  
  if (isFlushingWork) {
    // Prevent reentrancy.
    // TODO: Is this overly defensive? The callers must check the execution
    // context first regardless.
    return;
  }

  // 检查是否有同步工作         
  if (!mightHavePendingSyncWork) {
    // Fast path. There's no sync work to do.
    return;
  }

  // There may or may not be synchronous work scheduled. Let's check.
  let didPerformSomeWork;
  isFlushingWork = true; // 标记正在刷新
  do {
    didPerformSomeWork = false; // 标记没有同步工作
    let root = firstScheduledRoot;
    while (root !== null) {
      if (onlyLegacy && (disableLegacyMode || root.tag !== LegacyRoot)) {
        // Skip non-legacy roots.
      } else {
        if (syncTransitionLanes !== NoLanes) {
          const nextLanes = getNextLanesToFlushSync(root, syncTransitionLanes);
          if (nextLanes !== NoLanes) {
            // This root has pending sync work. Flush it now.
            didPerformSomeWork = true; // 标记有同步工作
            performSyncWorkOnRoot(root, nextLanes); // 执行同步工作
          }
        } else {
          const workInProgressRoot = getWorkInProgressRoot();
          const workInProgressRootRenderLanes =
            getWorkInProgressRootRenderLanes();
          const rootHasPendingCommit =
            root.cancelPendingCommit !== null ||
            root.timeoutHandle !== noTimeout;
          const nextLanes = getNextLanes(
            root,
            root === workInProgressRoot
              ? workInProgressRootRenderLanes
              : NoLanes,
            rootHasPendingCommit,
          );
          if (
            (includesSyncLane(nextLanes) ||
              (enableGestureTransition && isGestureRender(nextLanes))) &&
            !checkIfRootIsPrerendering(root, nextLanes)
          ) {
            // This root has pending sync work. Flush it now.
            didPerformSomeWork = true;
            performSyncWorkOnRoot(root, nextLanes);
          }
        }
      }
      root = root.next;
    }
  } while (didPerformSomeWork);
  isFlushingWork = false;
}


function processRootScheduleInImmediateTask() {
  // if (enableProfilerTimer && enableComponentPerformanceTrack) {
  //   // Track the currently executing event if there is one so we can ignore this
  //   // event when logging events.
  //   trackSchedulerEvent();
  // }

  processRootScheduleInMicrotask();
}
/**
 * React 调度系统的核心函数，负责在微任务中遍历所有待调度的根节点，为每个根节点安排任务，并在最后刷新同步工作
 */
function processRootScheduleInMicrotask() {
  // This function is always called inside a microtask. It should never be
  // called synchronously.
  didScheduleMicrotask = false; // 标记未调度
  if (__DEV__) {
    didScheduleMicrotask_act = false;
  }

  // We'll recompute this as we iterate through all the roots and schedule them.
  mightHavePendingSyncWork = false; // 标记未有待处理的同步工作

  // 同步过渡 lanes 处理
  let syncTransitionLanes = NoLanes;
  if (currentEventTransitionLane !== NoLane) {
    if (shouldAttemptEagerTransition()) {
      // A transition was scheduled during an event, but we're going to try to
      // render it synchronously anyway. We do this during a popstate event to
      // preserve the scroll position of the previous page.
      syncTransitionLanes = currentEventTransitionLane;
    } else if (enableDefaultTransitionIndicator) {
      // If we have a Transition scheduled by this event it might be paired
      // with Default lane scheduled loading indicators. To unbatch it from
      // other events later on, flush it early to determine whether it
      // rendered an indicator. This ensures that setState in default priority
      // event doesn't trigger onDefaultTransitionIndicator.
      syncTransitionLanes = DefaultLane;
    }
  }

  const currentTime = now();

  let prev = null;
  let root = firstScheduledRoot;
  // 遍历所有待调度的根节点
  while (root !== null) {
    const next = root.next;
    // 为当前根节点安排任务
    const nextLanes = scheduleTaskForRootDuringMicrotask(root, currentTime);

    // 从链表中移除 已完成的根节点
    if (nextLanes === NoLane) {
      // This root has no more pending work. Remove it from the schedule. To
      // guard against subtle reentrancy bugs, this microtask is the only place
      // we do this — you can add roots to the schedule whenever, but you can
      // only remove them here.

      // Null this out so we know it's been removed from the schedule.
      root.next = null;
      if (prev === null) {
        // This is the new head of the list
        firstScheduledRoot = next;
      } else {
        prev.next = next;
      }
      if (next === null) {
        // This is the new tail of the list
        lastScheduledRoot = prev;
      }
    } else {
      // This root still has work. Keep it in the list.
      prev = root;

      // This is a fast-path optimization to early exit from
      // flushSyncWorkOnAllRoots if we can be certain that there is no remaining
      // synchronous work to perform. Set this to true if there might be sync
      // work left.
      if (
        // Skip the optimization if syncTransitionLanes is set
        syncTransitionLanes !== NoLanes ||
        // Common case: we're not treating any extra lanes as synchronous, so we
        // can just check if the next lanes are sync.
        includesSyncLane(nextLanes) ||
        (enableGestureTransition && isGestureRender(nextLanes))
      ) {
        mightHavePendingSyncWork = true; // 标记有待处理的同步工作
      }
    }
    root = next;
  }

  // At the end of the microtask, flush any pending synchronous work. This has
  // to come at the end, because it does actual rendering work that might throw.
  // If we're in the middle of a View Transition async sequence, we don't want to
  // interrupt that sequence. Instead, we'll flush any remaining work when it
  // completes.
  // 刷新同步工作
  if (!hasPendingCommitEffects()) {
    flushSyncWorkAcrossRoots_impl(syncTransitionLanes, false);
  }

  // 重置事件过渡 lane
  if (currentEventTransitionLane !== NoLane) {
    // Reset Event Transition Lane so that we allocate a new one next time.
    currentEventTransitionLane = NoLane;
    startDefaultTransitionIndicatorIfNeeded();
  }
}

function startDefaultTransitionIndicatorIfNeeded() {
  if (!enableDefaultTransitionIndicator) {
    return;
  }
  // Check if we need to start an isomorphic indicator like if an async action
  // was started.
  startIsomorphicDefaultIndicatorIfNeeded();
  // Check all the roots if there are any new indicators needed.
  let root = firstScheduledRoot;
  while (root !== null) {
    if (root.indicatorLanes !== NoLanes && root.pendingIndicator === null) {
      // We have new indicator lanes that requires a loading state. Start the
      // default transition indicator.
      if (hasOngoingIsomorphicIndicator()) {
        // We already have an isomorphic indicator going which means it has to
        // also apply to this root since it implies all roots have the same one.
        // We retain this indicator so that it keeps going until we commit this
        // root.
        root.pendingIndicator = retainIsomorphicIndicator();
      } else {
        try {
          const onDefaultTransitionIndicator =
            root.onDefaultTransitionIndicator;
          root.pendingIndicator = onDefaultTransitionIndicator() || noop;
        } catch (x) {
          root.pendingIndicator = noop;
          reportGlobalError(x);
        }
      }
    }
    root = root.next;
  }
}

/**
 * 负责在微任务中为单个根节点计算下一个要处理的优先级 lanes，并根据优先级调度相应的任务
 * @param {*} root 
 * @param {*} currentTime 
 * @returns 
 */
function scheduleTaskForRootDuringMicrotask(
  root: FiberRoot,
  currentTime: number,
): Lane {
  // This function is always called inside a microtask, or at the very end of a
  // rendering task right before we yield to the main thread. It should never be
  // called synchronously.

  // This function also never performs React work synchronously; it should
  // only schedule work to be performed later, in a separate task or microtask.

  // Check if any lanes are being starved by other work. If so, mark them as
  // expired so we know to work on those next.
  markStarvedLanesAsExpired(root, currentTime); // 标记过期的 lanes

  // Determine the next lanes to work on, and their priority.
  const rootWithPendingPassiveEffects = getRootWithPendingPassiveEffects();
  const pendingPassiveEffectsLanes = getPendingPassiveEffectsLanes();
  const workInProgressRoot = getWorkInProgressRoot();
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();

  const rootHasPendingCommit =
    root.cancelPendingCommit !== null || root.timeoutHandle !== noTimeout;

  const nextLanes =
    enableYieldingBeforePassive && root === rootWithPendingPassiveEffects
      ? // This will schedule the callback at the priority of the lane but we used to
        // always schedule it at NormalPriority. Discrete will flush it sync anyway.
        // So the only difference is Idle and it doesn't seem necessarily right for that
        // to get upgraded beyond something important just because we're past commit.
        pendingPassiveEffectsLanes
      : getNextLanes(
          root,
          root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
          rootHasPendingCommit,
        );

  const existingCallbackNode = root.callbackNode;

  // 快速路径：没有待处理的 lanes
  if (
    // Check if there's nothing to work on
    nextLanes === NoLanes ||
    // If this root is currently suspended and waiting for data to resolve, don't
    // schedule a task to render it. We'll either wait for a ping, or wait to
    // receive an update.
    //
    // Suspended render phase
    (root === workInProgressRoot && isWorkLoopSuspendedOnData()) ||
    // Suspended commit phase
    root.cancelPendingCommit !== null
  ) {
    // Fast path: There's nothing to work on.
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode); // 取消已调度的回调
    }
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return NoLane;
  }

  // Schedule a new callback in the host environment.
  // 同步任务处理
  if (
    includesSyncLane(nextLanes) &&
    // If we're prerendering, then we should use the concurrent work loop
    // even if the lanes are synchronous, so that prerendering never blocks
    // the main thread.
    !checkIfRootIsPrerendering(root, nextLanes)
  ) {
    // Synchronous work is always flushed at the end of the microtask, so we
    // don't need to schedule an additional task.
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackPriority = SyncLane;
    root.callbackNode = null;
    return SyncLane;

    // 异步任务处理
  } else {
    // We use the highest priority lane to represent the priority of the callback.
    const existingCallbackPriority = root.callbackPriority;
    const newCallbackPriority = getHighestPriorityLane(nextLanes);

    // 快速路径：优先级未改变
    if (
      newCallbackPriority === existingCallbackPriority &&
      // Special case related to `act`. If the currently scheduled task is a
      // Scheduler task, rather than an `act` task, cancel it and re-schedule
      // on the `act` queue.
      !(
        __DEV__ &&
        ReactSharedInternals.actQueue !== null &&
        existingCallbackNode !== fakeActCallbackNode
      )
    ) {
      // The priority hasn't changed. We can reuse the existing task.
      return newCallbackPriority;
    } else {
      // Cancel the existing callback. We'll schedule a new one below.
      cancelCallback(existingCallbackNode);
    }

    //  转换优先级并调度新任务     
    let schedulerPriorityLevel;
    switch (lanesToEventPriority(nextLanes)) {
      // Scheduler does have an "ImmediatePriority", but now that we use
      // microtasks for sync work we no longer use that. Any sync work that
      // reaches this path is meant to be time sliced.
      case DiscreteEventPriority:
      case ContinuousEventPriority:
        schedulerPriorityLevel = UserBlockingSchedulerPriority; // 2
        break;
      case DefaultEventPriority:
        schedulerPriorityLevel = NormalSchedulerPriority; // 3
        break;
      case IdleEventPriority:
        schedulerPriorityLevel = IdleSchedulerPriority; // 5
        break;
      default:
        schedulerPriorityLevel = NormalSchedulerPriority; // 3
        break;
    }

    const newCallbackNode = scheduleCallback(
      schedulerPriorityLevel,
      performWorkOnRootViaSchedulerTask.bind(null, root),
    );

    root.callbackPriority = newCallbackPriority;
    root.callbackNode = newCallbackNode;
    return newCallbackPriority;
  }
}

type RenderTaskFn = (didTimeout: boolean) => RenderTaskFn | null;

/**
 * Scheduler 调度的并发任务的入口点，负责执行 React 的渲染工作循环，支持可中断渲染和时间切片
 * @param {*} root 
 * @param {*} didTimeout 
 * @returns 
 */
function performWorkOnRootViaSchedulerTask(
  root: FiberRoot,
  didTimeout: boolean,
): RenderTaskFn | null {
  // This is the entry point for concurrent tasks scheduled via Scheduler (and
  // postTask, in the future).

  // if (enableProfilerTimer && enableProfilerNestedUpdatePhase) {
  //   resetNestedUpdateFlag();
  // }

  // if (enableProfilerTimer && enableComponentPerformanceTrack) {
  //   // Track the currently executing event if there is one so we can ignore this
  //   // event when logging events.
  //   trackSchedulerEvent();
  // }

  // 检查异步提交状态（ pendingEffectsStatus 不等于 0 并且 不等于 5-【PENDING_PASSIVE_PHASE】 ）
  if (hasPendingCommitEffects()) {
    // We are currently in the middle of an async committing (such as a View Transition).
    // We could force these to flush eagerly but it's better to defer any work until
    // it finishes. This may not be the same root as we're waiting on.
    // TODO: This relies on the commit eventually calling ensureRootIsScheduled which
    // always calls processRootScheduleInMicrotask which in turn always loops through
    // all the roots to figure out. This is all a bit inefficient and if optimized
    // it'll need to consider rescheduling a task for any skipped roots.
    // callbackNode 存储当前已调度的任务引用
    // 如果不重置，下次调度时会认为已有任务在等待，可能跳过调度
    root.callbackNode = null; 
    // callbackPriority 表示当前任务的优先级
    // 重置为 NoLane 表示没有待处理的任务
    root.callbackPriority = NoLane;
    return null;
  }

  // Flush any pending passive effects before deciding which lanes to work on,
  // in case they schedule additional work.
  const originalCallbackNode = root.callbackNode;
  // 刷新被动副作用
  const didFlushPassiveEffects = flushPendingEffectsDelayed();
   // 被动副作用已被刷新
  if (didFlushPassiveEffects) {
    // Something in the passive effect phase may have canceled the current task.
    // Check if the task node for this root was changed.
    if (root.callbackNode !== originalCallbackNode) {
      // The current task was canceled. Exit. We don't need to call
      // `ensureRootIsScheduled` because the check above implies either that
      // there's a new task, or that there's no remaining work on this root.
      // 任务被取消
      return null;
    } else {
      // Current task was not canceled. Continue.
    }
  }

  // Determine the next lanes to work on, using the fields stored on the root.
  // TODO: We already called getNextLanes when we scheduled the callback; we
  // should be able to avoid calling it again by stashing the result on the
  // root object. However, because we always schedule the callback during
  // a microtask (scheduleTaskForRootDuringMicrotask), it's possible that
  // an update was scheduled earlier during this same browser task (and
  // therefore before the microtasks have run). That's because Scheduler batches
  // together multiple callbacks into a single browser macrotask, without
  // yielding to microtasks in between. We should probably change this to align
  // with the postTask behavior (and literally use postTask when
  // it's available).
  const workInProgressRoot = getWorkInProgressRoot(); // 获取当前正在执行的工作根节点
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes(); // 获取当前正在执行的工作根节点的待处理车道
  // 检查根节点是否有待处理的任务
  const rootHasPendingCommit =
     // 取消待处理的提交 、超时处理
    root.cancelPendingCommit !== null || root.timeoutHandle !== noTimeout;
    // 获取下一个待处理的车道
  const lanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
    rootHasPendingCommit,
  );
  if (lanes === NoLanes) {
    // 没有待处理的任务
    // No more work on this root.
    return null;
  }

  // Enter the work loop.
  // TODO: We only check `didTimeout` defensively, to account for a Scheduler
  // bug we're still investigating. Once the bug in Scheduler is fixed,
  // we can remove this, since we track expiration ourselves.
  // 超时强制同步
  // disableSchedulerTimeoutInWorkLoop 控制是否禁用 Scheduler 的超时机制在工作循环中的使用， false 表示Scheduler 超时机制
  const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;
  performWorkOnRoot(root, lanes, forceSync);

  // The work loop yielded, but there may or may not be work left at the current
  // priority. Need to determine whether we need to schedule a continuation.
  // Usually `scheduleTaskForRootDuringMicrotask` only runs inside a microtask;
  // however, since most of the logic for determining if we need a continuation
  // versus a new task is the same, we cheat a bit and call it here. This is
  // only safe to do because we know we're at the end of the browser task.
  // So although it's not an actual microtask, it might as well be.
  // 续体机制
  // 支持任务续体，允许工作循环在中断后继续执行同一任务
  scheduleTaskForRootDuringMicrotask(root, now());
  
  // root.callbackNode != null 代表根节点有带执行的调度任务
  // root.callbackNode === originalCallbackNode 代表当前任务是原始任务，需要继续执行
  if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
    // The task node scheduled for this root is the same one that's
    // currently executed. Need to return a continuation.
    return performWorkOnRootViaSchedulerTask.bind(null, root);
  }
  return null;
}

/**
 * 同步执行根节点的渲染和提交工作
 * @param {*} root 
 * @param {*} lanes 
 * @returns 
 */
function performSyncWorkOnRoot(root: FiberRoot, lanes: Lanes) {
  // This is the entry point for synchronous tasks that don't go
  // through Scheduler.
  // 刷新被动副作用
  const didFlushPassiveEffects = flushPendingEffects();
  // 如果有 effects 被刷新，退出    
  if (didFlushPassiveEffects) {
    // If passive effects were flushed, exit to the outer work loop in the root
    // scheduler, so we can recompute the priority.
    return null;
  }
  // if (enableProfilerTimer && enableProfilerNestedUpdatePhase) {
  //   syncNestedUpdateFlag();
  // }
  const forceSync = true; // 强制同步执行

  // 执行同步工作    
  performWorkOnRoot(root, lanes, forceSync);
}

const fakeActCallbackNode = {};

function scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: RenderTaskFn,
) {
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // Special case: We're inside an `act` scope (a testing utility).
    // Instead of scheduling work in the host environment, add it to a
    // fake internal queue that's managed by the `act` implementation.
    ReactSharedInternals.actQueue.push(callback);
    return fakeActCallbackNode;
  } else {
    return Scheduler_scheduleCallback(priorityLevel, callback);
  }
}

function cancelCallback(callbackNode: mixed) {
  if (__DEV__ && callbackNode === fakeActCallbackNode) {
    // Special `act` case: check if this is the fake callback node used by
    // the `act` implementation.
  } else if (callbackNode !== null) {
    Scheduler_cancelCallback(callbackNode);
  }
}

/**
 * React 调度系统的底层调度函数，负责将根节点调度任务安排到合适的执行队列中。
 */
function scheduleImmediateRootScheduleTask() {

  // act 测试环境检查
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // Special case: Inside an `act` scope, we push microtasks to the fake `act`
    // callback queue. This is because we currently support calling `act`
    // without awaiting the result. The plan is to deprecate that, and require
    // that you always await the result so that the microtasks have a chance to
    // run. But it hasn't happened yet.
    ReactSharedInternals.actQueue.push(() => {
      processRootScheduleInMicrotask();
      return null;
    });
  }

  // TODO: Can we land supportsMicrotasks? Which environments don't support it?
  // Alternatively, can we move this check to the host config?
  // 微任务支持检查
  if (supportsMicrotasks) {
    scheduleMicrotask(() => {
      // In Safari, appending an iframe forces microtasks to run.
      // https://github.com/facebook/react/issues/22459
      // We don't support running callbacks in the middle of render
      // or commit so we need to check against that.
      const executionContext = getExecutionContext();

      // 在渲染/提交阶段
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
        // Note that this would still prematurely flush the callbacks
        // if this happens outside render or commit phase (e.g. in an event).

        // Intentionally using a macrotask instead of a microtask here. This is
        // wrong semantically but it prevents an infinite loop. The bug is
        // Safari's, not ours, so we just do our best to not crash even though
        // the behavior isn't completely correct.
        Scheduler_scheduleCallback(
          ImmediateSchedulerPriority, // 1 立即执行优先级
          processRootScheduleInImmediateTask,
        );
        return;
      }
      processRootScheduleInMicrotask();
    });
  } else {
    // If microtasks are not supported, use Scheduler.
    // 降级方案
    Scheduler_scheduleCallback(
      ImmediateSchedulerPriority, // 1 立即执行优先级
      processRootScheduleInImmediateTask,
    );
  }
}

export function requestTransitionLane(
  // This argument isn't used, it's only here to encourage the caller to
  // check that it's inside a transition before calling this function.
  // TODO: Make this non-nullable. Requires a tweak to useOptimistic.
  transition: Transition | null,
): Lane {
  // The algorithm for assigning an update to a lane should be stable for all
  // updates at the same priority within the same event. To do this, the
  // inputs to the algorithm must be the same.
  //
  // The trick we use is to cache the first of each of these inputs within an
  // event. Then reset the cached values once we can be sure the event is
  // over. Our heuristic for that is whenever we enter a concurrent work loop.
  if (currentEventTransitionLane === NoLane) {
    // All transitions within the same event are assigned the same lane.
    const actionScopeLane = peekEntangledActionLane();
    currentEventTransitionLane =
      actionScopeLane !== NoLane
        ? // We're inside an async action scope. Reuse the same lane.
          actionScopeLane
        : // We may or may not be inside an async action scope. If we are, this
          // is the first update in that scope. Either way, we need to get a
          // fresh transition lane.
          claimNextTransitionUpdateLane();
  }
  return currentEventTransitionLane;
}

export function didCurrentEventScheduleTransition(): boolean {
  return currentEventTransitionLane !== NoLane;
}

export function markIndicatorHandled(root: FiberRoot): void {
  if (enableDefaultTransitionIndicator) {
    // The current transition event rendered a synchronous loading state.
    // Clear it from the indicator lanes. We don't need to show a separate
    // loading state for this lane.
    root.indicatorLanes &= ~currentEventTransitionLane;
    markIsomorphicIndicatorHandled();
  }
}
