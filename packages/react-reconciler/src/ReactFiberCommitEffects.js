/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  ViewTransitionProps,
  ProfilerProps,
  ProfilerPhase,
} from 'shared/ReactTypes';
import type {Fiber} from './ReactInternalTypes';
import type {UpdateQueue} from './ReactFiberClassUpdateQueue';
import type {FunctionComponentUpdateQueue} from './ReactFiberHooks';
import type {HookFlags} from './ReactHookEffectTags';
import type {FragmentInstanceType} from './ReactFiberConfig';
import type {ViewTransitionState} from './ReactFiberViewTransitionComponent';

import {getViewTransitionName} from './ReactFiberViewTransitionComponent';

import {
  enableProfilerTimer,
  enableProfilerCommitHooks,
  enableProfilerNestedUpdatePhase,
  enableSchedulingProfiler,
  enableViewTransition,
  enableFragmentRefs,
} from 'shared/ReactFeatureFlags';
import {
  ClassComponent,
  Fragment,
  HostComponent,
  HostHoistable,
  HostSingleton,
  ViewTransitionComponent,
} from './ReactWorkTags';
import {NoFlags} from './ReactFiberFlags';
import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import {resolveClassComponentProps} from './ReactFiberClassComponent';
import {
  recordEffectDuration,
  startEffectTimer,
  isCurrentUpdateNested,
} from './ReactProfilerTimer';
import {NoMode, ProfileMode} from './ReactTypeOfMode';
import {
  commitCallbacks,
  commitHiddenCallbacks,
} from './ReactFiberClassUpdateQueue';
import {
  getPublicInstance,
  createViewTransitionInstance,
  createFragmentInstance,
} from './ReactFiberConfig';
import {
  captureCommitPhaseError,
  setIsRunningInsertionEffect,
} from './ReactFiberWorkLoop';
import {
  NoFlags as NoHookEffect,
  Layout as HookLayout,
  Insertion as HookInsertion,
  Passive as HookPassive,
} from './ReactHookEffectTags';
import {didWarnAboutReassigningProps} from './ReactFiberBeginWork';
import {
  markComponentPassiveEffectMountStarted,
  markComponentPassiveEffectMountStopped,
  markComponentPassiveEffectUnmountStarted,
  markComponentPassiveEffectUnmountStopped,
  markComponentLayoutEffectMountStarted,
  markComponentLayoutEffectMountStopped,
  markComponentLayoutEffectUnmountStarted,
  markComponentLayoutEffectUnmountStopped,
} from './ReactFiberDevToolsHook';
import {
  callComponentDidMountInDEV,
  callComponentDidUpdateInDEV,
  callComponentWillUnmountInDEV,
  callCreateInDEV,
  callDestroyInDEV,
} from './ReactFiberCallUserSpace';

import {runWithFiberInDEV} from './ReactCurrentFiber';

function shouldProfile(current: Fiber): boolean {
  return (
    enableProfilerTimer &&
    enableProfilerCommitHooks &&
    (current.mode & ProfileMode) !== NoMode
  );
}

export function commitHookLayoutEffects(
  finishedWork: Fiber,
  hookFlags: HookFlags,
) {
  // At this point layout effects have already been destroyed (during mutation phase).
  // This is done to prevent sibling component effects from interfering with each other,
  // e.g. a destroy function in one component should never override a ref set
  // by a create function in another component during the same commit.
  if (shouldProfile(finishedWork)) {
    startEffectTimer();
    commitHookEffectListMount(hookFlags, finishedWork);
    recordEffectDuration(finishedWork);
  } else {
    commitHookEffectListMount(hookFlags, finishedWork);
  }
}

export function commitHookLayoutUnmountEffects(
  finishedWork: Fiber,
  nearestMountedAncestor: null | Fiber,
  hookFlags: HookFlags,
) {
  // Layout effects are destroyed during the mutation phase so that all
  // destroy functions for all fibers are called before any create functions.
  // This prevents sibling component effects from interfering with each other,
  // e.g. a destroy function in one component should never override a ref set
  // by a create function in another component during the same commit.
  if (shouldProfile(finishedWork)) {
    startEffectTimer();
    commitHookEffectListUnmount(
      hookFlags,
      finishedWork,
      nearestMountedAncestor,
    );
    recordEffectDuration(finishedWork);
  } else {
    commitHookEffectListUnmount(
      hookFlags,
      finishedWork,
      nearestMountedAncestor,
    );
  }
}

/**
 * 
 * @param {*} flags Hook 类型标记（HookPassive、HookLayout、HookInsertion）
 * @param {*} finishedWork 已完成的 fiber 节点
 */
export function commitHookEffectListMount(
  flags: HookFlags,
  finishedWork: Fiber,
) {
  try {
    // 获取 updateQueue
    const updateQueue: FunctionComponentUpdateQueue | null =
      (finishedWork.updateQueue: any);

      // 获取 lastEffect         
    const lastEffect = updateQueue !== null ? updateQueue.lastEffect : null;

    // 遍历 Effect 循环链表  
    if (lastEffect !== null) {
      const firstEffect = lastEffect.next;
      let effect = firstEffect;
      // 使用 do-while 确保至少执行一次
      do {
        if ((effect.tag & flags) === flags) {
          // if (enableSchedulingProfiler) {
          //   if ((flags & HookPassive) !== NoHookEffect) {
          //     markComponentPassiveEffectMountStarted(finishedWork);
          //   } else if ((flags & HookLayout) !== NoHookEffect) {
          //     markComponentLayoutEffectMountStarted(finishedWork);
          //   }
          // }

          // Mount
          let destroy;
          if (__DEV__) {
            // if ((flags & HookInsertion) !== NoHookEffect) {
            //   setIsRunningInsertionEffect(true);
            // }
            // destroy = runWithFiberInDEV(finishedWork, callCreateInDEV, effect);
            // if ((flags & HookInsertion) !== NoHookEffect) {
            //   setIsRunningInsertionEffect(false);
            // }
          } else {
            const create = effect.create;
            const inst = effect.inst;
            destroy = create(); // 执行 create 函数，返回 清理函数
            inst.destroy = destroy; // 把清理函数赋值给 inst.destroy
          }

          // if (enableSchedulingProfiler) {
          //   if ((flags & HookPassive) !== NoHookEffect) {
          //     markComponentPassiveEffectMountStopped();
          //   } else if ((flags & HookLayout) !== NoHookEffect) {
          //     markComponentLayoutEffectMountStopped();
          //   }
          // }

          if (__DEV__) {
            // 返回值不是 undefined 且 返回值不是函数，报错
            if (destroy !== undefined && typeof destroy !== 'function') {
              // 确定 Hook 名称
              let hookName;
              if ((effect.tag & HookLayout) !== NoFlags) {
                hookName = 'useLayoutEffect';
              } else if ((effect.tag & HookInsertion) !== NoFlags) {
                hookName = 'useInsertionEffect';
              } else {
                hookName = 'useEffect';
              }
              let addendum;

              // 返回 null，报错
              if (destroy === null) {
                addendum =
                  ' You returned null. If your effect does not require clean ' +
                  'up, return undefined (or nothing).';
                // $FlowFixMe (@poteto) this check is safe on arbitrary non-null/void objects
              } else if (typeof destroy.then === 'function') {
                // 返回 Promise，报错
                addendum =
                  '\n\nIt looks like you wrote ' +
                  hookName +
                  '(async () => ...) or returned a Promise. ' +
                  'Instead, write the async function inside your effect ' +
                  'and call it immediately:\n\n' +
                  hookName +
                  '(() => {\n' +
                  '  async function fetchData() {\n' +
                  '    // You can await here\n' +
                  '    const response = await MyAPI.getData(someId);\n' +
                  '    // ...\n' +
                  '  }\n' +
                  '  fetchData();\n' +
                  `}, [someId]); // Or [] if effect doesn't need props or state\n\n` +
                  'Learn more about data fetching with Hooks: https://react.dev/link/hooks-data-fetching';
              } else {
                // $FlowFixMe[unsafe-addition] (@poteto)
                // 返回其他类型，报错
                addendum = ' You returned: ' + destroy;
              }
              runWithFiberInDEV(
                finishedWork,
                (n, a) => {
                  console.error(
                    '%s must not return anything besides a function, ' +
                      'which is used for clean-up.%s',
                    n,
                    a,
                  );
                },
                hookName,
                addendum,
              );
            }
          }
        }
        effect = effect.next; // 继续遍历下一个 effect
      } while (effect !== firstEffect);
    }
  } catch (error) {
    captureCommitPhaseError(finishedWork, finishedWork.return, error);
  }
}

/**
 * 执行 Hook Effects 的 Unmount（卸载清理）
 * @param {*} flags Hook 类型标记
 * @param {*} finishedWork 已完成的 fiber 节点
 * @param {*} nearestMountedAncestor 最近的已挂载祖先
 */
export function commitHookEffectListUnmount(
  flags: HookFlags,
  finishedWork: Fiber,
  nearestMountedAncestor: Fiber | null,
) {
  try {
    const updateQueue: FunctionComponentUpdateQueue | null =
      (finishedWork.updateQueue: any);
    const lastEffect = updateQueue !== null ? updateQueue.lastEffect : null;

    // 遍历 fiber 的 Effect 链表  
    if (lastEffect !== null) {
      const firstEffect = lastEffect.next;
      let effect = firstEffect;
      do {
        if ((effect.tag & flags) === flags) {
          // Unmount
          const inst = effect.inst;
          const destroy = inst.destroy;
          if (destroy !== undefined) {
            inst.destroy = undefined; // 清理函数赋值为 undefined
            // if (enableSchedulingProfiler) {
            //   if ((flags & HookPassive) !== NoHookEffect) {
            //     markComponentPassiveEffectUnmountStarted(finishedWork);
            //   } else if ((flags & HookLayout) !== NoHookEffect) {
            //     markComponentLayoutEffectUnmountStarted(finishedWork);
            //   }
            // }

            // if (__DEV__) {
            //   if ((flags & HookInsertion) !== NoHookEffect) {
            //     setIsRunningInsertionEffect(true);
            //   }
            // }

            // 执行 effect.inst.destroy
            safelyCallDestroy(finishedWork, nearestMountedAncestor, destroy);

            // if (__DEV__) {
            //   if ((flags & HookInsertion) !== NoHookEffect) {
            //     setIsRunningInsertionEffect(false);
            //   }
            // }

            // if (enableSchedulingProfiler) {
            //   if ((flags & HookPassive) !== NoHookEffect) {
            //     markComponentPassiveEffectUnmountStopped();
            //   } else if ((flags & HookLayout) !== NoHookEffect) {
            //     markComponentLayoutEffectUnmountStopped();
            //   }
            // }
          }
        }
        effect = effect.next; // 继续遍历下一个 effect
      } while (effect !== firstEffect);
    }
  } catch (error) {
    captureCommitPhaseError(finishedWork, finishedWork.return, error);
  }
}

/**
 * 执行函数组件的 Passive Effects 的 Mount 阶段
 * - 执行 useEffect 的 create() 函数  
 * 时机：在 Commit 阶段的 Passive 阶段     
 * @param {*} finishedWork 已完成的 fiber 节点
 * @param {*} hookFlags Hook 标志位
 */
export function commitHookPassiveMountEffects(
  finishedWork: Fiber,
  hookFlags: HookFlags,
) {
  if (shouldProfile(finishedWork)) {
    startEffectTimer();
    commitHookEffectListMount(hookFlags, finishedWork); // 执行 effects
    recordEffectDuration(finishedWork);
  } else {
    commitHookEffectListMount(hookFlags, finishedWork); // 直接执行
  }
}

/**
 * 执行函数组件的 Passive Effects 的 Unmount 阶段
 * @param {*} finishedWork 
 * @param {*} nearestMountedAncestor 
 * @param {*} hookFlags 
 */
export function commitHookPassiveUnmountEffects(
  finishedWork: Fiber,
  nearestMountedAncestor: null | Fiber,
  hookFlags: HookFlags,
) {
  if (shouldProfile(finishedWork)) {
    startEffectTimer();
    commitHookEffectListUnmount(
      hookFlags,
      finishedWork,
      nearestMountedAncestor,
    );
    recordEffectDuration(finishedWork);
  } else {
    commitHookEffectListUnmount(
      hookFlags,
      finishedWork,
      nearestMountedAncestor,
    );
  }
}

/**
 * 执行 ClassComponent 的 Layout 阶段生命周期方法
 * @param {*} finishedWork 已完成的 fiber 节点
 * @param {*} current 旧 fiber
 */
export function commitClassLayoutLifecycles(
  finishedWork: Fiber,
  current: Fiber | null,
) {
  const instance = finishedWork.stateNode;
  if (current === null) {
    // We could update instance props and state here,
    // but instead we rely on them being set during last render.
    // TODO: revisit this when we implement resuming.
    if (__DEV__) {
      if (
        !finishedWork.type.defaultProps &&
        !('ref' in finishedWork.memoizedProps) &&
        !didWarnAboutReassigningProps
      ) {
        if (instance.props !== finishedWork.memoizedProps) {
          console.error(
            'Expected %s props to match memoized props before ' +
              'componentDidMount. ' +
              'This might either be because of a bug in React, or because ' +
              'a component reassigns its own `this.props`. ' +
              'Please file an issue.',
            getComponentNameFromFiber(finishedWork) || 'instance',
          );
        }
        if (instance.state !== finishedWork.memoizedState) {
          console.error(
            'Expected %s state to match memoized state before ' +
              'componentDidMount. ' +
              'This might either be because of a bug in React, or because ' +
              'a component reassigns its own `this.state`. ' +
              'Please file an issue.',
            getComponentNameFromFiber(finishedWork) || 'instance',
          );
        }
      }
    }
    if (shouldProfile(finishedWork)) {
      startEffectTimer();
      if (__DEV__) {
        runWithFiberInDEV(
          finishedWork,
          callComponentDidMountInDEV,
          finishedWork,
          instance,
        );
      } else {
        try {
          instance.componentDidMount();
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      recordEffectDuration(finishedWork);
    } else {
      if (__DEV__) {
        runWithFiberInDEV(
          finishedWork,
          callComponentDidMountInDEV,
          finishedWork,
          instance,
        );
      } else {
        try {
          // 首次渲染时， current 为 null
          // 执行 componentDidMount()   
          instance.componentDidMount();
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
    }
  } else {
    const prevProps = resolveClassComponentProps(
      finishedWork.type,
      current.memoizedProps,
    );
    const prevState = current.memoizedState;
    // We could update instance props and state here,
    // but instead we rely on them being set during last render.
    // TODO: revisit this when we implement resuming.
    if (__DEV__) {
      if (
        !finishedWork.type.defaultProps &&
        !('ref' in finishedWork.memoizedProps) &&
        !didWarnAboutReassigningProps
      ) {
        if (instance.props !== finishedWork.memoizedProps) {
          console.error(
            'Expected %s props to match memoized props before ' +
              'componentDidUpdate. ' +
              'This might either be because of a bug in React, or because ' +
              'a component reassigns its own `this.props`. ' +
              'Please file an issue.',
            getComponentNameFromFiber(finishedWork) || 'instance',
          );
        }
        if (instance.state !== finishedWork.memoizedState) {
          console.error(
            'Expected %s state to match memoized state before ' +
              'componentDidUpdate. ' +
              'This might either be because of a bug in React, or because ' +
              'a component reassigns its own `this.state`. ' +
              'Please file an issue.',
            getComponentNameFromFiber(finishedWork) || 'instance',
          );
        }
      }
    }
    if (shouldProfile(finishedWork)) {
      startEffectTimer();
      if (__DEV__) {
        runWithFiberInDEV(
          finishedWork,
          callComponentDidUpdateInDEV,
          finishedWork,
          instance,
          prevProps,
          prevState,
          instance.__reactInternalSnapshotBeforeUpdate,
        );
      } else {
        try {
          instance.componentDidUpdate(
            prevProps,
            prevState,
            instance.__reactInternalSnapshotBeforeUpdate,
          );
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      recordEffectDuration(finishedWork);
    } else {
      if (__DEV__) {
        runWithFiberInDEV(
          finishedWork,
          callComponentDidUpdateInDEV,
          finishedWork,
          instance,
          prevProps,
          prevState,
          instance.__reactInternalSnapshotBeforeUpdate,
        );
      } else {
        try {
          // 执行 componentDidUpdate()   
          instance.componentDidUpdate(
            prevProps,// 旧 props
            prevState, // 旧 state
            instance.__reactInternalSnapshotBeforeUpdate,// getSnapshotBeforeUpdate() 的返回值 
          );
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
    }
  }
}

/**
 * 执行组件的 componentDidMount 方法
 * @param {*} finishedWork 
 */
export function commitClassDidMount(finishedWork: Fiber) {
  // TODO: Check for LayoutStatic flag
  const instance = finishedWork.stateNode;
  if (typeof instance.componentDidMount === 'function') {
    if (__DEV__) {
      // runWithFiberInDEV(
      //   finishedWork,
      //   callComponentDidMountInDEV,
      //   finishedWork,
      //   instance,
      // );
    } else {
      try {
        instance.componentDidMount();
      } catch (error) {
        captureCommitPhaseError(finishedWork, finishedWork.return, error);
      }
    }
  }
}

/**
 * 执行 ClassComponent 的 setState callback（回调）
 * @param {*} finishedWork 
 */
export function commitClassCallbacks(finishedWork: Fiber) {
  // TODO: I think this is now always non-null by the time it reaches the
  // commit phase. Consider removing the type check.
  const updateQueue: UpdateQueue<mixed> | null =
    (finishedWork.updateQueue: any);
    
  if (updateQueue !== null) {
    const instance = finishedWork.stateNode;
    if (__DEV__) {
      if (
        !finishedWork.type.defaultProps &&
        !('ref' in finishedWork.memoizedProps) &&
        !didWarnAboutReassigningProps
      ) {
        if (instance.props !== finishedWork.memoizedProps) {
          console.error(
            'Expected %s props to match memoized props before ' +
              'processing the update queue. ' +
              'This might either be because of a bug in React, or because ' +
              'a component reassigns its own `this.props`. ' +
              'Please file an issue.',
            getComponentNameFromFiber(finishedWork) || 'instance',
          );
        }
        if (instance.state !== finishedWork.memoizedState) {
          console.error(
            'Expected %s state to match memoized state before ' +
              'processing the update queue. ' +
              'This might either be because of a bug in React, or because ' +
              'a component reassigns its own `this.state`. ' +
              'Please file an issue.',
            getComponentNameFromFiber(finishedWork) || 'instance',
          );
        }
      }
    }
    // We could update instance props and state here,
    // but instead we rely on them being set during last render.
    // TODO: revisit this when we implement resuming.
    try {
      if (__DEV__) {
        runWithFiberInDEV(finishedWork, commitCallbacks, updateQueue, instance);
      } else {
        commitCallbacks(updateQueue, instance);
      }
    } catch (error) {
      captureCommitPhaseError(finishedWork, finishedWork.return, error);
    }
  }
}

export function commitClassHiddenCallbacks(finishedWork: Fiber) {
  // Commit any callbacks that would have fired while the component
  // was hidden.
  const updateQueue: UpdateQueue<mixed> | null =
    (finishedWork.updateQueue: any);
  if (updateQueue !== null) {
    const instance = finishedWork.stateNode;
    try {
      if (__DEV__) {
        runWithFiberInDEV(
          finishedWork,
          commitHiddenCallbacks,
          updateQueue,
          instance,
        );
      } else {
        commitHiddenCallbacks(updateQueue, instance);
      }
    } catch (error) {
      captureCommitPhaseError(finishedWork, finishedWork.return, error);
    }
  }
}

export function commitRootCallbacks(finishedWork: Fiber) {
  // TODO: I think this is now always non-null by the time it reaches the
  // commit phase. Consider removing the type check.
  const updateQueue: UpdateQueue<mixed> | null =
    (finishedWork.updateQueue: any);
  if (updateQueue !== null) {
    let instance = null;
    if (finishedWork.child !== null) {
      switch (finishedWork.child.tag) {
        case HostSingleton:
        case HostComponent:
          instance = getPublicInstance(finishedWork.child.stateNode);
          break;
        case ClassComponent:
          instance = finishedWork.child.stateNode;
          break;
      }
    }
    try {
      if (__DEV__) {
        runWithFiberInDEV(finishedWork, commitCallbacks, updateQueue, instance);
      } else {
        commitCallbacks(updateQueue, instance);
      }
    } catch (error) {
      captureCommitPhaseError(finishedWork, finishedWork.return, error);
    }
  }
}

let didWarnAboutUndefinedSnapshotBeforeUpdate: Set<mixed> | null = null;
if (__DEV__) {
  didWarnAboutUndefinedSnapshotBeforeUpdate = new Set();
}

function callGetSnapshotBeforeUpdates(
  instance: any,
  prevProps: any,
  prevState: any,
) {
  return instance.getSnapshotBeforeUpdate(prevProps, prevState);
}

export function commitClassSnapshot(finishedWork: Fiber, current: Fiber) {
  const prevProps = current.memoizedProps;
  const prevState = current.memoizedState;
  const instance = finishedWork.stateNode;
  // We could update instance props and state here,
  // but instead we rely on them being set during last render.
  // TODO: revisit this when we implement resuming.
  if (__DEV__) {
    if (
      !finishedWork.type.defaultProps &&
      !('ref' in finishedWork.memoizedProps) &&
      !didWarnAboutReassigningProps
    ) {
      if (instance.props !== finishedWork.memoizedProps) {
        console.error(
          'Expected %s props to match memoized props before ' +
            'getSnapshotBeforeUpdate. ' +
            'This might either be because of a bug in React, or because ' +
            'a component reassigns its own `this.props`. ' +
            'Please file an issue.',
          getComponentNameFromFiber(finishedWork) || 'instance',
        );
      }
      if (instance.state !== finishedWork.memoizedState) {
        console.error(
          'Expected %s state to match memoized state before ' +
            'getSnapshotBeforeUpdate. ' +
            'This might either be because of a bug in React, or because ' +
            'a component reassigns its own `this.state`. ' +
            'Please file an issue.',
          getComponentNameFromFiber(finishedWork) || 'instance',
        );
      }
    }
  }
  try {
    const resolvedPrevProps = resolveClassComponentProps(
      finishedWork.type,
      prevProps,
    );
    let snapshot;
    if (__DEV__) {
      snapshot = runWithFiberInDEV(
        finishedWork,
        callGetSnapshotBeforeUpdates,
        instance,
        resolvedPrevProps,
        prevState,
      );
      const didWarnSet =
        ((didWarnAboutUndefinedSnapshotBeforeUpdate: any): Set<mixed>);
      if (snapshot === undefined && !didWarnSet.has(finishedWork.type)) {
        didWarnSet.add(finishedWork.type);
        runWithFiberInDEV(finishedWork, () => {
          console.error(
            '%s.getSnapshotBeforeUpdate(): A snapshot value (or null) ' +
              'must be returned. You have returned undefined.',
            getComponentNameFromFiber(finishedWork),
          );
        });
      }
    } else {
      snapshot = callGetSnapshotBeforeUpdates(
        instance,
        resolvedPrevProps,
        prevState,
      );
    }
    instance.__reactInternalSnapshotBeforeUpdate = snapshot;
  } catch (error) {
    captureCommitPhaseError(finishedWork, finishedWork.return, error);
  }
}

// Capture errors so they don't interrupt unmounting.
/**
 * 安全调用组件的 componentWillUnmount 方法
 * @param {*} current 
 * @param {*} nearestMountedAncestor 
 * @param {*} instance 
 */
export function safelyCallComponentWillUnmount(
  current: Fiber,
  nearestMountedAncestor: Fiber | null,
  instance: any,
) {
  instance.props = resolveClassComponentProps(
    current.type,
    current.memoizedProps,
  );
  instance.state = current.memoizedState;
  if (shouldProfile(current)) {
    startEffectTimer();
    if (__DEV__) {
      runWithFiberInDEV(
        current,
        callComponentWillUnmountInDEV,
        current,
        nearestMountedAncestor,
        instance,
      );
    } else {
      try {
        instance.componentWillUnmount();
      } catch (error) {
        captureCommitPhaseError(current, nearestMountedAncestor, error);
      }
    }
    recordEffectDuration(current);
  } else {
    if (__DEV__) {
      // runWithFiberInDEV(
      //   current,
      //   callComponentWillUnmountInDEV,
      //   current,
      //   nearestMountedAncestor,
      //   instance,
      // );
    } else {
      try {
        instance.componentWillUnmount();
      } catch (error) {
        captureCommitPhaseError(current, nearestMountedAncestor, error);
      }
    }
  }
}
/**
 * 将 Ref 附加到 DOM 实例或组件实例
 * @param {*} finishedWork 
 */
function commitAttachRef(finishedWork: Fiber) {
  const ref = finishedWork.ref;
  if (ref !== null) {
    let instanceToUse;
    switch (finishedWork.tag) {
      case HostHoistable:
      case HostSingleton:
      case HostComponent:
        instanceToUse = getPublicInstance(finishedWork.stateNode);
        break;
      case ViewTransitionComponent: {
        if (enableViewTransition) {
          const instance: ViewTransitionState = finishedWork.stateNode;
          const props: ViewTransitionProps = finishedWork.memoizedProps;
          const name = getViewTransitionName(props, instance);
          if (instance.ref === null || instance.ref.name !== name) {
            instance.ref = createViewTransitionInstance(name);
          }
          instanceToUse = instance.ref;
          break;
        }
        instanceToUse = finishedWork.stateNode;
        break;
      }
      case Fragment:
        if (enableFragmentRefs) {
          const instance: null | FragmentInstanceType = finishedWork.stateNode;
          if (instance === null) {
            finishedWork.stateNode = createFragmentInstance(finishedWork);
          }
          instanceToUse = finishedWork.stateNode;
          break;
        }
      // Fallthrough
      default:
        instanceToUse = finishedWork.stateNode;
    }
    // 函数 ref：调用 ref(instance) 
    if (typeof ref === 'function') {
      if (shouldProfile(finishedWork)) {
        try {
          startEffectTimer();
          finishedWork.refCleanup = ref(instanceToUse);
        } finally {
          recordEffectDuration(finishedWork);
        }
      } else {
        finishedWork.refCleanup = ref(instanceToUse);
      }
    } else {
      
      if (__DEV__) {
        // TODO: We should move these warnings to happen during the render
        // phase (markRef).
        // 不再支持字符串 ref，仅支持函数 ref 或对象 ref
        if (typeof ref === 'string') {
          // 字符串 ref 是旧版 React 的特性，已废弃
          console.error('String refs are no longer supported.');
          

        //  检查 ref 是否有 current 属性，如果没有，说明是无效的 ref 对象
        } else if (!ref.hasOwnProperty('current')) {
          // 提示使用 useRef() 或 React.createRef()
          console.error(
            'Unexpected ref object provided for %s. ' +
              'Use either a ref-setter function or React.createRef().',
            getComponentNameFromFiber(finishedWork),
          );
        }
      }

      // 对象 ref：ref.current = instance  
      // $FlowFixMe[incompatible-use] unable to narrow type to the non-function case
      ref.current = instanceToUse;
    }
  }
}

// Capture errors so they don't interrupt mounting.
/**
 * 安全地附加 Ref 引用
 * @param {*} current 
 * @param {*} nearestMountedAncestor 
 */
export function safelyAttachRef(
  current: Fiber,
  nearestMountedAncestor: Fiber | null,
) {
  try {
    if (__DEV__) {
      runWithFiberInDEV(current, commitAttachRef, current);
    } else {
      commitAttachRef(current);
    }
  } catch (error) {
    captureCommitPhaseError(current, nearestMountedAncestor, error);
  }
}

/**
 * 安全地分离 Ref 引用
 * @param {*} current 当前 fiber 节点
 * @param {*} nearestMountedAncestor 最近的已挂载祖先
 */
export function safelyDetachRef(
  current: Fiber,
  nearestMountedAncestor: Fiber | null,
) {
  const ref = current.ref;
  const refCleanup = current.refCleanup;

  if (ref !== null) {
    // 如果有 refCleanup，调用清理函数  
    if (typeof refCleanup === 'function') {
      try {
        if (shouldProfile(current)) {
          // try {
          //   startEffectTimer();
          //   if (__DEV__) {
          //     runWithFiberInDEV(current, refCleanup);
          //   } else {
          //     refCleanup();
          //   }
          // } finally {
          //   recordEffectDuration(current);
          // }
        } else {
          if (__DEV__) {
            // runWithFiberInDEV(current, refCleanup);
          } else {
            refCleanup();
          }
        }
      } catch (error) {
        captureCommitPhaseError(current, nearestMountedAncestor, error);
      } finally {
        // `refCleanup` has been called. Nullify all references to it to prevent double invocation.
        current.refCleanup = null;
        const finishedWork = current.alternate;
        if (finishedWork != null) {
          finishedWork.refCleanup = null;
        }
      }
    } else if (typeof ref === 'function') {
      // 如果是函数 ref，调用 ref(null) 解绑    
      try {
        if (shouldProfile(current)) {
          // try {
          //   startEffectTimer();
          //   if (__DEV__) {
          //     (runWithFiberInDEV(current, ref, null): void);
          //   } else {
          //     ref(null);
          //   }
          // } finally {
          //   recordEffectDuration(current);
          // }
        } else {
          if (__DEV__) {
            // (runWithFiberInDEV(current, ref, null): void);
          } else {
            ref(null);
          }
        }
      } catch (error) {
        captureCommitPhaseError(current, nearestMountedAncestor, error);
      }
    } else {
      // 如果是对象 ref，设置 ref.current = null 
      // $FlowFixMe[incompatible-use] unable to narrow type to RefObject
      ref.current = null;
    }
  }
}

/**
 * 为什么需要 safelyCallDestroy？  
 * - 防止清理函数抛出错误导致渲染崩溃     
 * @param {*} current 
 * @param {*} nearestMountedAncestor 
 * @param {*} destroy 
 * @param  {...any} */ 
function safelyCallDestroy(
  current: Fiber,
  nearestMountedAncestor: Fiber | null,
  destroy: (() => void) | (({...}) => void),
  resource?: {...} | void | null,
) {
  // $FlowFixMe[extra-arg] @poteto this is safe either way because the extra arg is ignored if it's not a CRUD effect
  // 支持带资源的清理函数   
  const destroy_ = resource == null ? destroy : destroy.bind(null, resource);
  if (__DEV__) {
    runWithFiberInDEV(
      current,
      callDestroyInDEV,
      current,
      nearestMountedAncestor,
      destroy_,
    );
  } else {
    try {
      // $FlowFixMe(incompatible-call) Already bound to resource
      destroy_(); // 执行 effect.inst.destroy
    } catch (error) {
      captureCommitPhaseError(current, nearestMountedAncestor, error);
    }
  }
}

function commitProfiler(
  finishedWork: Fiber,
  current: Fiber | null,
  commitStartTime: number,
  effectDuration: number,
) {
  const {id, onCommit, onRender} = (finishedWork.memoizedProps: ProfilerProps);

  let phase: ProfilerPhase = current === null ? 'mount' : 'update';
  if (enableProfilerNestedUpdatePhase) {
    if (isCurrentUpdateNested()) {
      phase = 'nested-update';
    }
  }

  if (typeof onRender === 'function') {
    onRender(
      id,
      phase,
      // $FlowFixMe: This should be always a number in profiling mode
      finishedWork.actualDuration,
      // $FlowFixMe: This should be always a number in profiling mode
      finishedWork.treeBaseDuration,
      // $FlowFixMe: This should be always a number in profiling mode
      finishedWork.actualStartTime,
      commitStartTime,
    );
  }

  if (enableProfilerCommitHooks) {
    if (typeof onCommit === 'function') {
      onCommit(id, phase, effectDuration, commitStartTime);
    }
  }
}

export function commitProfilerUpdate(
  finishedWork: Fiber,
  current: Fiber | null,
  commitStartTime: number,
  effectDuration: number,
) {
  if (enableProfilerTimer) {
    try {
      if (__DEV__) {
        runWithFiberInDEV(
          finishedWork,
          commitProfiler,
          finishedWork,
          current,
          commitStartTime,
          effectDuration,
        );
      } else {
        commitProfiler(finishedWork, current, commitStartTime, effectDuration);
      }
    } catch (error) {
      captureCommitPhaseError(finishedWork, finishedWork.return, error);
    }
  }
}

function commitProfilerPostCommitImpl(
  finishedWork: Fiber,
  current: Fiber | null,
  commitStartTime: number,
  passiveEffectDuration: number,
): void {
  const {id, onPostCommit} = finishedWork.memoizedProps;

  let phase = current === null ? 'mount' : 'update';
  if (enableProfilerNestedUpdatePhase) {
    if (isCurrentUpdateNested()) {
      phase = 'nested-update';
    }
  }

  if (typeof onPostCommit === 'function') {
    onPostCommit(id, phase, passiveEffectDuration, commitStartTime);
  }
}

export function commitProfilerPostCommit(
  finishedWork: Fiber,
  current: Fiber | null,
  commitStartTime: number,
  passiveEffectDuration: number,
) {
  try {
    if (__DEV__) {
      runWithFiberInDEV(
        finishedWork,
        commitProfilerPostCommitImpl,
        finishedWork,
        current,
        commitStartTime,
        passiveEffectDuration,
      );
    } else {
      commitProfilerPostCommitImpl(
        finishedWork,
        current,
        commitStartTime,
        passiveEffectDuration,
      );
    }
  } catch (error) {
    captureCommitPhaseError(finishedWork, finishedWork.return, error);
  }
}
