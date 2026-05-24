/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactInternalTypes';

export type StackCursor<T> = {current: T};

// 全局栈，用于存储值
const valueStack: Array<any> = [];

let fiberStack: Array<Fiber | null>;

if (__DEV__) {
  fiberStack = [];
}

let index = -1;

// 创建一个栈游标，用于访问当前栈顶值
function createCursor<T>(defaultValue: T): StackCursor<T> {
  return {
    current: defaultValue,
  };
}

function pop<T>(cursor: StackCursor<T>, fiber: Fiber): void {
  if (index < 0) {
    if (__DEV__) {
      console.error('Unexpected pop.');
    }
    return;
  }

  if (__DEV__) {
    if (fiber !== fiberStack[index]) {
      console.error('Unexpected Fiber popped.');
    }
  }

  cursor.current = valueStack[index];

  valueStack[index] = null;

  if (__DEV__) {
    fiberStack[index] = null;
  }

  index--;
}

/**
 * push 是 React Fiber 栈系统的核心函数，用于将值推入共享栈中，支持上下文、状态等数据的层级管理。
 * @param {*} cursor 
 * @param {*} value 
 * @param {*} fiber 
 */
function push<T>(cursor: StackCursor<T>, value: T, fiber: Fiber): void {
  // index 是全局栈指针，指向下一个可用位置
  index++;

  // 保存旧值到栈
  valueStack[index] = cursor.current;

  if (__DEV__) {
    fiberStack[index] = fiber;
  }

  // 更新 cursor 当前值
  cursor.current = value;
}
export {createCursor, pop, push};
