/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Wakeable,
  Thenable,
  FulfilledThenable,
  RejectedThenable,
  ReactDebugInfo,
  ReactIOInfo,
} from 'shared/ReactTypes';

import {enableAsyncDebugInfo} from 'shared/ReactFeatureFlags';

import {REACT_LAZY_TYPE} from 'shared/ReactSymbols';

import noop from 'shared/noop';

const Uninitialized = -1; // 未初始化，未调用
const Pending = 0; // 加载中
const Resolved = 1; // 加载成功
const Rejected = 2; // 加载失败

type UninitializedPayload<T> = {
  _status: -1,
  _result: () => Thenable<{default: T, ...}>,
  _ioInfo?: ReactIOInfo, // DEV-only
};

type PendingPayload = {
  _status: 0,
  _result: Wakeable,
  _ioInfo?: ReactIOInfo, // DEV-only
};

type ResolvedPayload<T> = {
  _status: 1,
  _result: {default: T, ...},
  _ioInfo?: ReactIOInfo, // DEV-only
};

type RejectedPayload = {
  _status: 2,
  _result: mixed,
  _ioInfo?: ReactIOInfo, // DEV-only
};

type Payload<T> =
  | UninitializedPayload<T>
  | PendingPayload
  | ResolvedPayload<T>
  | RejectedPayload;

export type LazyComponent<T, P> = {
  $$typeof: symbol | number,
  _payload: P,
  _init: (payload: P) => T,

  // __DEV__
  _debugInfo?: null | ReactDebugInfo,
  _store?: {validated: 0 | 1 | 2, ...}, // 0: not validated, 1: validated, 2: force fail
};

/**
 * 
 * @param {*} payload  懒加载的负载对象，包含状态和加载器
 */
function lazyInitializer<T>(payload: Payload<T>): T {
  // 未初始化处理
  if (payload._status === Uninitialized) {
    let resolveDebugValue: (void | T) => void = (null: any);
    let rejectDebugValue: mixed => void = (null: any);
    // if (__DEV__ && enableAsyncDebugInfo) {
    //   const ioInfo = payload._ioInfo;
    //   if (ioInfo != null) {
    //     // Mark when we first kicked off the lazy request.
    //     // $FlowFixMe[cannot-write]
    //     ioInfo.start = ioInfo.end = performance.now();
    //     // Stash a Promise for introspection of the value later.
    //     // $FlowFixMe[cannot-write]
    //     ioInfo.value = new Promise((resolve, reject) => {
    //       resolveDebugValue = resolve;
    //       rejectDebugValue = reject;
    //     });
    //   }
    // }
    const ctor = payload._result; // 加载器函数 （） => import("")
    const thenable = ctor(); // 加载器函数返回的 Thenable 对象
    // Transition to the next state.
    // This might throw either because it's missing or throws. If so, we treat it
    // as still uninitialized and try again next time. Which is the same as what
    // happens if the ctor or any wrappers processing the ctor throws. This might
    // end up fixing it if the resolution was a concurrency bug.
    // 监听 Promise 状态变化
    thenable.then(
      moduleObject => { // 加载成功
        // 正在加载、未初始化
        if (
          (payload: Payload<T>)._status === Pending ||
          payload._status === Uninitialized
        ) {
          // Transition to the next state.
          const resolved: ResolvedPayload<T> = (payload: any);
          resolved._status = Resolved; // 设置状态为加载成功
          resolved._result = moduleObject; // 设置结果为模块对象
          // if (__DEV__ && enableAsyncDebugInfo) {
          //   const ioInfo = payload._ioInfo;
          //   if (ioInfo != null) {
          //     // Mark the end time of when we resolved.
          //     // $FlowFixMe[cannot-write]
          //     ioInfo.end = performance.now();
          //     // Surface the default export as the resolved "value" for debug purposes.
          //     const debugValue =
          //       moduleObject == null ? undefined : moduleObject.default;
          //     resolveDebugValue(debugValue);
          //     // $FlowFixMe
          //     ioInfo.value.status = 'fulfilled';
          //     // $FlowFixMe
          //     ioInfo.value.value = debugValue;
          //   }
          // }
          // Make the thenable introspectable
          // TODO we should move the lazy introspection into the resolveLazy
          // impl or make suspendedThenable be able to be a lazy itself
          if (thenable.status === undefined) {
            const fulfilledThenable: FulfilledThenable<{default: T, ...}> =
              (thenable: any);
            fulfilledThenable.status = 'fulfilled'; // 设置状态为加载成功
            fulfilledThenable.value = moduleObject; // 设置值为模块对象
          }
        }
      },
      // 加载失败
      error => {
        if (
          (payload: Payload<T>)._status === Pending ||
          payload._status === Uninitialized
        ) {
          // Transition to the next state.
          const rejected: RejectedPayload = (payload: any);
          rejected._status = Rejected; // 设置状态为加载失败
          rejected._result = error; // 设置结果为错误对象
          // if (__DEV__ && enableAsyncDebugInfo) {
          //   const ioInfo = payload._ioInfo;
          //   if (ioInfo != null) {
          //     // Mark the end time of when we rejected.
          //     // $FlowFixMe[cannot-write]
          //     ioInfo.end = performance.now();
          //     // Hide unhandled rejections.
          //     // $FlowFixMe
          //     ioInfo.value.then(noop, noop);
          //     rejectDebugValue(error);
          //     // $FlowFixMe
          //     ioInfo.value.status = 'rejected';
          //     // $FlowFixMe
          //     ioInfo.value.reason = error;
          //   }
          // }
          // Make the thenable introspectable
          // TODO we should move the lazy introspection into the resolveLazy
          // impl or make suspendedThenable be able to be a lazy itself
          if (thenable.status === undefined) {
            const rejectedThenable: RejectedThenable<{default: T, ...}> =
              (thenable: any);
            rejectedThenable.status = 'rejected';
            rejectedThenable.reason = error;
          }
        }
      },
    );
    // if (__DEV__ && enableAsyncDebugInfo) {
    //   const ioInfo = payload._ioInfo;
    //   if (ioInfo != null) {
    //     const displayName = thenable.displayName;
    //     if (typeof displayName === 'string') {
    //       // $FlowFixMe[cannot-write]
    //       ioInfo.name = displayName;
    //     }
    //   }
    // }

    // 未初始化
    if (payload._status === Uninitialized) {
      // In case, we're still uninitialized, then we're waiting for the thenable
      // to resolve. Set it as pending in the meantime.
      const pending: PendingPayload = (payload: any);
      pending._status = Pending;
      pending._result = thenable;
    }
  }
  // 加载成功
  if (payload._status === Resolved) {
    const moduleObject = payload._result;
    // if (__DEV__) {
    //   if (moduleObject === undefined) {
    //     console.error(
    //       'lazy: Expected the result of a dynamic imp' +
    //         'ort() call. ' +
    //         'Instead received: %s\n\nYour code should look like: \n  ' +
    //         // Break up imports to avoid accidentally parsing them as dependencies.
    //         'const MyComponent = lazy(() => imp' +
    //         "ort('./MyComponent'))\n\n" +
    //         'Did you accidentally put curly braces around the import?',
    //       moduleObject,
    //     );
    //   }
    // }
    // if (__DEV__) {
    //   if (!('default' in moduleObject)) {
    //     console.error(
    //       'lazy: Expected the result of a dynamic imp' +
    //         'ort() call. ' +
    //         'Instead received: %s\n\nYour code should look like: \n  ' +
    //         // Break up imports to avoid accidentally parsing them as dependencies.
    //         'const MyComponent = lazy(() => imp' +
    //         "ort('./MyComponent'))",
    //       moduleObject,
    //     );
    //   }
    // }
    return moduleObject.default; // 返回模块对象的默认导出
  } else {
    throw payload._result;
  }
}

/**
 * 
 * @param {*} ctor 返回 Promise 的工厂函数（通常是 import()）
 * @param  {...any} */ 
export function lazy<T>(
  ctor: () => Thenable<{default: T, ...}>,
): LazyComponent<T, Payload<T>> {

  // 创建 payload 对象
  const payload: Payload<T> = {
    // We use these fields to store the result.
    _status: Uninitialized, // 初始化，未调用
    _result: ctor, // 存储工厂函数
  };

  // 创建 lazyType 对象   
  const lazyType: LazyComponent<T, Payload<T>> = {
    $$typeof: REACT_LAZY_TYPE, // 标识是 lazy 组件
    _payload: payload, // 存储 payload 对象，加载信息
    _init: lazyInitializer, // 初始化函数
  };

  // if (__DEV__ && enableAsyncDebugInfo) {
  //   // TODO: We should really track the owner here but currently ReactIOInfo
  //   // can only contain ReactComponentInfo and not a Fiber. It's unusual to
  //   // create a lazy inside an owner though since they should be in module scope.
  //   const owner = null;
  //   const ioInfo: ReactIOInfo = {
  //     name: 'lazy',
  //     start: -1,
  //     end: -1,
  //     value: null,
  //     owner: owner,
  //     debugStack: new Error('react-stack-top-frame'),
  //     // eslint-disable-next-line react-internal/no-production-logging
  //     debugTask: console.createTask ? console.createTask('lazy()') : null,
  //   };
  //   payload._ioInfo = ioInfo;
  //   // Add debug info to the lazy, but this doesn't have an await stack yet.
  //   // That will be inferred by later usage.
  //   lazyType._debugInfo = [{awaited: ioInfo}];
  // }

  return lazyType;
}
