/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {
  enableViewTransition,
  enableGestureTransition,
} from 'shared/ReactFeatureFlags';
import {startTransition} from './ReactStartTransition';

export type TransitionTypes = Array<string>;

/**
 * 为当前 Transition 添加一个类型标记
 * @param {*} type 
 */
export function addTransitionType(type: string): void {
  if (enableViewTransition) {
    // 获取当前 Transition
    const transition = ReactSharedInternals.T;

    // 1、在 Transition 中
    if (transition !== null) {
      const transitionTypes = transition.types;
      if (transitionTypes === null) {
        transition.types = [type]; // 创建新数组 [type]
      } else if (transitionTypes.indexOf(type) === -1) {
        transitionTypes.push(type);
      }
    } else {
      // 2、不在 Transition 中
      // We're in the async gap. Simulate an implicit startTransition around it.
      if (__DEV__) {
        if (ReactSharedInternals.asyncTransitions === 0) {
          if (enableGestureTransition) {
            // 限制调用位置为 startTransition 或 startGestureTransition 回调中
            console.error(
              'addTransitionType can only be called inside a `startTransition()` ' +
                'or `startGestureTransition()` callback. ' +
                'It must be associated with a specific Transition.',
            );
          } else {
            // 限制调用位置为 startTransition 回调中
            console.error(
              'addTransitionType can only be called inside a `startTransition()` ' +
                'callback. It must be associated with a specific Transition.',
            );
          }
        }
      }
      // 自动用 startTransition 包装
      startTransition(addTransitionType.bind(null, type));
    }
  }
}
