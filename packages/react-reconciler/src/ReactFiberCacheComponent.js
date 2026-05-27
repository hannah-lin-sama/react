/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';
import type {Fiber} from 'react-reconciler/src/ReactInternalTypes';

import {REACT_CONTEXT_TYPE} from 'shared/ReactSymbols';

import {pushProvider, popProvider} from './ReactFiberNewContext';
import * as Scheduler from 'scheduler';

// In environments without AbortController (e.g. tests)
// replace it with a lightweight shim that only has the features we use.
const AbortControllerLocal: typeof AbortController =
  typeof AbortController !== 'undefined'
    ? AbortController
    : // $FlowFixMe[incompatible-type]
      // $FlowFixMe[missing-this-annot]
      function AbortControllerShim() {
        const listeners = [];
        const signal = (this.signal = {
          aborted: false as boolean,
          addEventListener: (type, listener) => {
            listeners.push(listener);
          },
        });

        this.abort = () => {
          signal.aborted = true;
          listeners.forEach(listener => listener());
        };
      };

export type Cache = {
  controller: AbortController,
  data: Map<() => mixed, mixed>,
  refCount: number,
};

export type CacheComponentState = {
  +parent: Cache,
  +cache: Cache,
};

export type SpawnedCachePool = {
  +parent: Cache,
  +pool: Cache,
};

// Intentionally not named imports because Rollup would
// use dynamic dispatch for CommonJS interop named imports.
const {
  unstable_scheduleCallback: scheduleCallback,
  unstable_NormalPriority: NormalPriority,
} = Scheduler;

export const CacheContext: ReactContext<Cache> = {
  $$typeof: REACT_CONTEXT_TYPE,
  // We don't use Consumer/Provider for Cache components. So we'll cheat.
  Consumer: (null: any),
  Provider: (null: any),
  // We'll initialize these at the root.
  _currentValue: (null: any),
  _currentValue2: (null: any),
  _threadCount: 0,
};

if (__DEV__) {
  CacheContext._currentRenderer = null;
  CacheContext._currentRenderer2 = null;
}

// Creates a new empty Cache instance with a ref-count of 0. The caller is responsible
// for retaining the cache once it is in use (retainCache), and releasing the cache
// once it is no longer needed (releaseCache).
/**
 * 创建新的空 Cache 实例
 * @returns 
 */
export function createCache(): Cache {
  return {
    controller: new AbortControllerLocal(), // // 中止控制器
    data: new Map(), // 存储缓存数据
    refCount: 0, // 引用计数，初始为 0
  };
}

/**
 * 增加缓存的引用计数，防止被 GC 回收
 * @param {*} cache 
 */
export function retainCache(cache: Cache) {
  if (__DEV__) {
    // 检查是否已释放
    if (cache.controller.signal.aborted) {
      console.warn(
        'A cache instance was retained after it was already freed. ' +
          'This likely indicates a bug in React.',
      );
    }
  }
  // 增加缓存的引用计数，防止被 GC 回收
  cache.refCount++;
}

// Cleanup a cache instance, potentially freeing it if there are no more references
/**
 * 减少缓存的引用计数，归零时释放缓存
 * @param {*} cache 
 */
export function releaseCache(cache: Cache) {
  // 减少引用计数
  cache.refCount--;
  if (__DEV__) {
    // 检查是否过度释放
    if (cache.refCount < 0) {
      console.warn(
        'A cache instance was released after it was already freed. ' +
          'This likely indicates a bug in React.',
      );
    }
  }
  // 引用归零，调度中止
  if (cache.refCount === 0) {
    // 调度低优先级任务
    scheduleCallback(NormalPriority, () => {
      // 调用 abort() 中止相关请求
      cache.controller.abort();
    });
  }
}

export function pushCacheProvider(workInProgress: Fiber, cache: Cache) {
  pushProvider(workInProgress, CacheContext, cache);
}

export function popCacheProvider(workInProgress: Fiber, cache: Cache) {
  popProvider(CacheContext, workInProgress);
}
