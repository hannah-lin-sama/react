/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

type Heap<T: Node> = Array<T>;
type Node = {
  id: number,
  sortIndex: number,
  ...
};

export function push<T: Node>(heap: Heap<T>, node: T): void {
  const index = heap.length;
  heap.push(node);
  siftUp(heap, node, index);
}

export function peek<T: Node>(heap: Heap<T>): T | null {
  return heap.length === 0 ? null : heap[0];
}

/**
 * 最小堆（MinHeap）的弹出操作，负责删除并返回堆顶元素（最小元素），同时维护堆的性质
 * @param {*} heap 
 * @returns 
 */
export function pop<T: Node>(heap: Heap<T>): T | null {
  if (heap.length === 0) {
    return null;
  }
  const first = heap[0];
  const last = heap.pop();
  if (last !== first) {
    // $FlowFixMe[incompatible-type]
    // 替换堆顶：用最后一个元素替换堆顶
    heap[0] = last;
    // $FlowFixMe[incompatible-call]
    // 向下调整：确保堆顶性质维护
    siftDown(heap, last, 0);
  }
  return first;
}

/**
 * 最小堆（MinHeap）的向上调整函数，用于在插入新节点后维护堆的性质，确保父节点始终小于等于子节点。
 * @param {*} heap 
 * @param {*} node 
 * @param {*} i 
 * @returns 
 */
function siftUp<T: Node>(heap: Heap<T>, node: T, i: number): void {
  let index = i;
  while (index > 0) {

    // 计算父节点索引
    const parentIndex = (index - 1) >>> 1;
    const parent = heap[parentIndex]; // 父节点
    if (compare(parent, node) > 0) {
      // 最小堆性质：父节点必须小于等于子节点
      // 递归调整：如果父节点更大，交换后继续向上检查
      // The parent is larger. Swap positions.
      heap[parentIndex] = node;
      heap[index] = parent;
      index = parentIndex;
    } else {
      // The parent is smaller. Exit.
      return;
    }
  }
}

/**
 * 最小堆（MinHeap）的向下调整函数，用于在删除堆顶元素后维护堆的性质，确保父节点始终小于等于子节点
 * @param {*} heap 
 * @param {*} node 
 * @param {*} i 
 * @returns 
 */
function siftDown<T: Node>(heap: Heap<T>, node: T, i: number): void {
  let index = i;
  const length = heap.length;
  const halfLength = length >>> 1; // 最后一个非叶子节点位置

  // 非叶子节点范围：只有前 halfLength 个节点可能有子节点
  while (index < halfLength) {
    // 左子节点索引：(i + 1) * 2 - 1 = 2i + 1
    const leftIndex = (index + 1) * 2 - 1;
    const left = heap[leftIndex];
    // 右子节点索引：(i + 1) * 2 = 2i + 2
    const rightIndex = leftIndex + 1;
    const right = heap[rightIndex];

    // If the left or right node is smaller, swap with the smaller of those.
    if (compare(left, node) < 0) {
      if (rightIndex < length && compare(right, left) < 0) {
        // 右子节点最小 → 与右子节点交换
        heap[index] = right;
        heap[rightIndex] = node;
        index = rightIndex;
      } else {
        // 左子节点最小 → 与左子节点交换
        heap[index] = left;
        heap[leftIndex] = node;
        index = leftIndex;
      }
    } else if (rightIndex < length && compare(right, node) < 0) {
       // 右子节点小于当前节点 → 与右子节点交换
      heap[index] = right;
      heap[rightIndex] = node;
      index = rightIndex;
    } else {
      // Neither child is smaller. Exit.
      return;
    }
  }
}

function compare(a: Node, b: Node) {
  // Compare sort index first, then task id.
  const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;
}
