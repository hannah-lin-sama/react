/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-disable no-var */

import type {PriorityLevel} from '../SchedulerPriorities';

import {
  enableProfiling,
  frameYieldMs,
  userBlockingPriorityTimeout,
  lowPriorityTimeout,
  normalPriorityTimeout,
  enableRequestPaint,
  enableAlwaysYieldScheduler,
} from '../SchedulerFeatureFlags';

import {push, pop, peek} from '../SchedulerMinHeap';

// TODO: Use symbols?
import {
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
} from '../SchedulerPriorities';
import {
  markTaskRun,
  markTaskYield,
  markTaskCompleted,
  markTaskCanceled,
  markTaskErrored,
  markSchedulerSuspended,
  markSchedulerUnsuspended,
  markTaskStart,
  stopLoggingProfilingEvents,
  startLoggingProfilingEvents,
} from '../SchedulerProfiling';

export type Callback = boolean => ?Callback;

export opaque type Task = {
  id: number,
  callback: Callback | null,
  priorityLevel: PriorityLevel,
  startTime: number,
  expirationTime: number,
  sortIndex: number,
  isQueued?: boolean,
};

let getCurrentTime: () => number | DOMHighResTimeStamp;
const hasPerformanceNow =
  // $FlowFixMe[method-unbinding]
  typeof performance === 'object' && typeof performance.now === 'function';

if (hasPerformanceNow) {
  const localPerformance = performance;
  getCurrentTime = () => localPerformance.now();
} else {
  const localDate = Date;
  const initialTime = localDate.now();
  getCurrentTime = () => localDate.now() - initialTime;
}

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Tasks are stored on a min heap
var taskQueue: Array<Task> = []; // 执行队列
var timerQueue: Array<Task> = []; // 定时器队列

// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1;

var currentTask = null;
var currentPriorityLevel: PriorityLevel = NormalPriority;

// This is set while performing work, to prevent re-entrance.
var isPerformingWork = false;

var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false; // 

var needsPaint = false;

// Capture local references to native APIs, in case a polyfill overrides them.
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;

//  setImmediate
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom

/**
 * 将到期的任务从定时器队列转移到执行队列
 * @param {*} currentTime
 * @returns
 */
function advanceTimers(currentTime: number) {
  // Check for tasks that are no longer delayed and add them to the queue.
  let timer = peek(timerQueue); // 获取定时器队列中最早到期的任务
  // 循环处理所有到期任务
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue); // 任务已被取消，直接移除
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      // 任务已到期，转移到执行队列
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // Remaining timers are pending.
      // 任务未到期，退出循环（堆顶是最早的，后面的更晚）
      return;
    }
    timer = peek(timerQueue); // 获取下一个到期任务
  }
}

function handleTimeout(currentTime: number) {
  isHostTimeoutScheduled = false; // 标志无延迟的超时调度
  advanceTimers(currentTime);

  if (!isHostCallbackScheduled) {
    // 检查是否有任务需要执行
    if (peek(taskQueue) !== null) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    } else {
      // 检查是否有到期的定时器
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

function flushWork(initialTime: number) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        return workLoop(initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskErrored(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // No catch in prod code path.
      return workLoop(initialTime);
    }
  } finally {
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}
/**
 * workLoop 是 React Scheduler 的核心执行引擎，
 * 负责驱动任务的调度和执行，是实现 React 并发模式（Concurrent Mode）。
 * @param {*} initialTime
 * @returns
 */
function workLoop(initialTime: number) {
  let currentTime = initialTime;
  advanceTimers(currentTime); // 先处理到期任务
  // 从任务队列中按优先级取出任务执行
  currentTask = peek(taskQueue);

  // 主循环与时间切片控制
  while (currentTask !== null) {
    if (!enableAlwaysYieldScheduler) {
      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
        // 任务未过期且时间片耗尽，让出控制权 给浏览器
        break;
      }
    }

    const callback = currentTask.callback;
    // 执行任务回调
    if (typeof callback === 'function') {
      currentTask.callback = null; // 防止重复执行
      currentPriorityLevel = currentTask.priorityLevel;

      // 检查任务是否已过期
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      if (enableProfiling) {
        markTaskRun(currentTask, currentTime);
      }
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      if (typeof continuationCallback === 'function') {
        // 返回函数表示任务未完成，需要续传
        currentTask.callback = continuationCallback;
        if (enableProfiling) {
          markTaskYield(currentTask, currentTime);
        }
        advanceTimers(currentTime); // 处理到期任务
        return true; // 立即让出，下次继续执行
      } else {
        // 返回非函数表示任务完成
        if (enableProfiling) {
          markTaskCompleted(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue); // 任务已完成，从队列中移除
        }
        advanceTimers(currentTime); // 处理到期任务
      }
    } else {
      pop(taskQueue);
    }
    currentTask = peek(taskQueue);
    if (enableAlwaysYieldScheduler) {
      if (currentTask === null || currentTask.expirationTime > currentTime) {
        // This currentTask hasn't expired we yield to the browser task.
        break;
      }
    }
  }
  // Return whether there's additional work
  if (currentTask !== null) {
    return true; // 有更多任务需要执行
  } else {
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      // 调度下一个定时器
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false; // 没有更多任务需要执行
  }
}

function unstable_runWithPriority<T>(
  priorityLevel: PriorityLevel,
  eventHandler: () => T,
): T {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_next<T>(eventHandler: () => T): T {
  var priorityLevel: PriorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
  var parentPriorityLevel = currentPriorityLevel;
  // $FlowFixMe[incompatible-return]
  // $FlowFixMe[missing-this-annot]
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}

/**
 *  React Scheduler 的核心调度函数，负责将任务加入调度队列，并根据优先级和延迟时间安排执行
 * @param {*} priorityLevel  任务优先级
 * @param {*} callback 要执行的回调函数
 * @param {*} options  延迟执行选项
 * @returns 
 */
function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: Callback,
  options?: {delay: number},
): Task {
  var currentTime = getCurrentTime();

  // 计算开始时间
  var startTime;
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    if (typeof delay === 'number' && delay > 0) {
      startTime = currentTime + delay;
    } else {
      startTime = currentTime;
    }
  } else {
    startTime = currentTime;
  }

  // 根据优先级计算超时时间
  var timeout;
  switch (priorityLevel) {
    case ImmediatePriority: // 1 立即执行优先级
      // Times out immediately
      timeout = -1;
      break;
    case UserBlockingPriority: // 2 用户阻塞优先级
      // Eventually times out
      timeout = userBlockingPriorityTimeout; // 250ms
      break;
    case IdlePriority: // 5 空闲优先级
      // Never times out
      timeout = maxSigned31BitInt;
      break;
    case LowPriority: // 4 低优先级
      // Eventually times out
      timeout = lowPriorityTimeout; // 10000 ms
      break;
    case NormalPriority: // 3 正常优先级
    default:
      // Eventually times out
      timeout = normalPriorityTimeout; // 5000ms
      break;
  }

  // 计算过期时间
  var expirationTime = startTime + timeout;

  // 创建任务对象
  var newTask: Task = {
    id: taskIdCounter++, // 	唯一标识符
    callback, // 回调函数
    priorityLevel, // 	优先级
    startTime, // 开始时间
    expirationTime, // 过期时间
    sortIndex: -1, // 排序索引
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }

  // 任务入队
  if (startTime > currentTime) {
    // 延迟任务 → timerQueue
    // This is a delayed task.
    // 最小堆排序：按 startTime 排序
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      if (isHostTimeoutScheduled) {
        // Cancel an existing timeout.
        // 清除定时器
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true; // 标志有延迟的超时调度
      }
      // Schedule a timeout.
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    // 立即任务 → taskQueue
    // 最小堆排序：按 expirationTime 排序（越早过期优先级越高）
    newTask.sortIndex = expirationTime;
    push(taskQueue, newTask);
    // if (enableProfiling) {
    //   markTaskStart(newTask, currentTime);
    //   newTask.isQueued = true;
    // }
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    // isPerformingWork， true 代表 正在执行任务
    // isHostCallbackScheduled ， true 代表 已调度主机回调
    // 防止重复调度，确保同一时刻只有一个回调在等待
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    }
  }

  return newTask;
}

function unstable_cancelCallback(task: Task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}

function unstable_getCurrentPriorityLevel(): PriorityLevel {
  return currentPriorityLevel;
}

let isMessageLoopRunning = false;
let taskTimeoutID: TimeoutID = (-1: any);

// Scheduler periodically yields in case there is other work on the main
// thread, like user events. By default, it yields multiple times per frame.
// It does not attempt to align with frame boundaries, since most tasks don't
// need to be frame aligned; for those that do, use requestAnimationFrame.
let frameInterval: number = frameYieldMs; // 每帧时间间隔 (默认 5ms)
let startTime = -1; // 当前帧开始时间

/**
 * 判断是否应该让出主线程给浏览器
 * @returns 
 */
function shouldYieldToHost(): boolean {
  	// enableRequestPaint 是否启用请求重绘检测
  if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
    // Yield now.
    // 需要重绘，立即让出
    return true;
  }
  // 检查时间片
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) {
    // The main thread has only been blocked for a really short amount of time;
    // smaller than a single frame. Don't yield yet.
    // 时间片未用完，不让出
    return false;
  }
  // Yield now.
  // 时间片用完，让出
  return true;
}

function requestPaint() {
  if (enableRequestPaint) {
    needsPaint = true; // 标志需要重绘
  }
}

function forceFrameRate(fps: number) {
  if (fps < 0 || fps > 125) {
    // Using console['error'] to evade Babel and ESLint
    console['error'](
      'forceFrameRate takes a positive int between 0 and 125, ' +
        'forcing frame rates higher than 125 fps is not supported',
    );
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);
  } else {
    // reset the framerate
    frameInterval = frameYieldMs;
  }
}

const performWorkUntilDeadline = () => {
  if (enableRequestPaint) {
    needsPaint = false;
  }

  // 消息循环是否正在运行
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    
    startTime = currentTime;

    let hasMoreWork = true; // 是否还有未完成的任务
    try {
      // 执行任务队列中的任务
      hasMoreWork = flushWork(currentTime);
    } finally {
      if (hasMoreWork) {
        // 继续调度
        schedulePerformWorkUntilDeadline();
      } else {
        isMessageLoopRunning = false;
      }
    }
  }
};

let schedulePerformWorkUntilDeadline;
// 支持 setImmediate
if (typeof localSetImmediate === 'function') {
  // Node.js and old IE.
  // There's a few reasons for why we prefer setImmediate.
  //
  // Unlike MessageChannel, it doesn't prevent a Node.js process from exiting.
  // (Even though this is a DOM fork of the Scheduler, you could get here
  // with a mix of Node.js 15+, which has a MessageChannel, and jsdom.)
  // https://github.com/facebook/react/issues/20756
  //
  // But also, it runs earlier which is the semantic we want.
  // If other browsers ever implement it, it's better to use it.
  // Although both of these would be inferior to native scheduling.
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
  // 支持 MessageChannel
} else if (typeof MessageChannel !== 'undefined') {
  // DOM and Worker environments.
  // We prefer MessageChannel because of the 4ms setTimeout clamping.
  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = performWorkUntilDeadline;
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null);
  };
  // 支持 setTimeout
} else {
  // We should only fallback here in non-browser environments.
  schedulePerformWorkUntilDeadline = () => {
    // $FlowFixMe[not-a-function] nullable value
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}

// 触发任务调度入口，负责启动消息循环并执行任务队列中的任务
function requestHostCallback() {
  // 启动调度消息循环（如果尚未运行）
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    // 根据运行环境选择不同的异步调度方式 setImmediate > MessageChannel > setTimeout
    schedulePerformWorkUntilDeadline();
  }
}

// 设置定时器，用于在指定时间后执行回调函数
function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number, // 延迟时间（毫秒）
) {
  // $FlowFixMe[not-a-function] nullable value
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());
  }, ms);
}

function cancelHostTimeout() {
  // $FlowFixMe[not-a-function] nullable value
  localClearTimeout(taskTimeoutID);
  taskTimeoutID = ((-1: any): TimeoutID);
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  requestPaint as unstable_requestPaint,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

export const unstable_Profiling: {
  startLoggingProfilingEvents(): void,
  stopLoggingProfilingEvents(): ArrayBuffer | null,
} | null = enableProfiling
  ? {
      startLoggingProfilingEvents,
      stopLoggingProfilingEvents,
    }
  : null;
