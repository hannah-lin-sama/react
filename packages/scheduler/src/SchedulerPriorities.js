/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

// TODO: Use symbols?
// 表示任务尚未分配优先级，或已完成/取消的任务
export const NoPriority = 0;
// 表示任务需要立即执行，例如响应用户输入或处理紧急事件
export const ImmediatePriority = 1;
// 表示任务需要在用户交互完成后执行，例如加载数据或更新视图
export const UserBlockingPriority = 2;
// 表示任务在正常操作中执行，例如处理用户输入或更新状态
export const NormalPriority = 3;
// 表示任务在低优先级队列中执行，例如后台任务或非紧急事件
export const LowPriority = 4;
// 表示任务在空闲时间执行，例如在用户交互之间
export const IdlePriority = 5;
