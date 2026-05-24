/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {
  enableCreateEventHandleAPI,
  enableEffectEventMutationPhase,
} from 'shared/ReactFeatureFlags';

export type Flags = number;

// Don't change these values. They're used by React Dev Tools.
export const NoFlags = /*                      */ 0b0000000000000000000000000000000;
// 执行了工作 1
export const PerformedWork = /*                */ 0b0000000000000000000000000000001;
// 需要插入 2
// 要在 DOM 中插入新节点
// 首次渲染、新增子节点
export const Placement = /*                    */ 0b0000000000000000000000000000010;
// 捕获了错误/suspense
export const DidCapture = /*                   */ 0b0000000000000000000000010000000;
// 水合中
export const Hydrating = /*                    */ 0b0000000000000000001000000000000;

// You can change the rest (and add more).
// 需要更新 4，需要更新现有节点
// setState / useState 更新、props 变化、context 变化
export const Update = /*                       */ 0b0000000000000000000000000000100;
// 已克隆
export const Cloned = /*                       */ 0b0000000000000000000000000001000;

// 子节点删除、有子节点需要删除
export const ChildDeletion = /*                */ 0b0000000000000000000000000010000;
// 内容重置
export const ContentReset = /*                 */ 0b0000000000000000000000000100000;
// 有回调
// 有 setState callback
// setState(state, callback)
export const Callback = /*                     */ 0b0000000000000000000000001000000;
/* Used by DidCapture:                            0b0000000000000000000000010000000; */

// 强制客户端渲染
export const ForceClientRender = /*            */ 0b0000000000000000000000100000000;
// 需要操作ref
// 需要附加/分离 ref
export const Ref = /*                          */ 0b0000000000000000000001000000000;
// 需要快照
// 需要获取 DOM 快照
// getSnapshotBeforeUpdate、componentDidMount / componentDidUpdate
export const Snapshot = /*                     */ 0b0000000000000000000010000000000;
// 有 passive 效果
// 有 useEffect 需要执行
// useEffect mount、update
export const Passive = /*                      */ 0b0000000000000000000100000000000;
/* Used by Hydrating:                             0b0000000000000000001000000000000; */

// 可见性变化
// Offscreen 组件可见性变化
export const Visibility = /*                   */ 0b0000000000000000010000000000000;
// store一致性检查
export const StoreConsistency = /*             */ 0b0000000000000000100000000000000;

// It's OK to reuse these bits because these flags are mutually exclusive for
// different fiber types. We should really be doing this for as many flags as
// possible, because we're about to run out of bits.
export const Hydrate = Callback;
export const ScheduleRetry = StoreConsistency;
export const ShouldSuspendCommit = Visibility;
export const ViewTransitionNamedMount = ShouldSuspendCommit;
export const DidDefer = ContentReset;

// 表单重置、同于 Snapshot
export const FormReset = Snapshot;
// 受影响的父组件布局、同于 ContentReset
export const AffectedParentLayout = ContentReset;

// 所有生命周期相关的 flags
export const LifecycleEffectMask =
  Passive | Update | Callback | Ref | Snapshot | StoreConsistency;

// Union of all commit flags (flags with the lifetime of a particular commit)
// 所有 commit 阶段的 flags
export const HostEffectMask = /*               */ 0b0000000000000000111111111111111;

// These are not really side effects, but we still reuse this field.
// 渲染未完成、用于 Suspense / ErrorBoundary
export const Incomplete = /*                   */ 0b0000000000000001000000000000000;
// 应该捕获错误/Suspense、与 DidCapture 配合使用
export const ShouldCapture = /*                */ 0b0000000000000010000000000000000;
// 强制更新（Legacy Suspense）、用于旧版 Suspense 兼容
export const ForceUpdateForLegacySuspense = /* */ 0b0000000000000100000000000000000;
// Context 已传播、用于 Context 传播优化
export const DidPropagateContext = /*          */ 0b0000000000001000000000000000000;
// 需要传播、用于 Suspense / Context 传播
export const NeedsPropagation = /*             */ 0b0000000000010000000000000000000;

// Static tags describe aspects of a fiber that are not specific to a render,
// e.g. a fiber uses a passive effect (even if there are no updates on this particular render).
// This enables us to defer more work in the unmount case,
// since we can defer traversing the tree during layout to look for Passive effects,
// and instead rely on the static flag as a signal that there may be cleanup work.
// 标识分叉的 fiber
export const Forked = /*                       */ 0b0000000000100000000000000000000;
// fiber 可能有 Snapshot effect、用于延迟遍历
export const SnapshotStatic = /*               */ 0b0000000001000000000000000000000;
// fiber 可能有 Layout effect、用于延迟遍历
export const LayoutStatic = /*                 */ 0b0000000010000000000000000000000;
// fiber 可能有 Ref effect
export const RefStatic = LayoutStatic;
// fiber 可能有 Passive effect
export const PassiveStatic = /*                */ 0b0000000100000000000000000000000;
// fiber 可能需要暂停提交、用于 Suspense
export const MaySuspendCommit = /*             */ 0b0000001000000000000000000000000;
// ViewTransitionNamedStatic tracks explicitly name ViewTransition components deeply
// that might need to be visited during clean up. This is similar to SnapshotStatic
// if there was any other use for it. It also needs to run in the same phase as
// MaySuspendCommit tracking.
// 命名 ViewTransition 组件、需要深度遍历清理
export const ViewTransitionNamedStatic =
  /*    */ SnapshotStatic | MaySuspendCommit;
// ViewTransitionStatic tracks whether there are an ViewTransition components from
// the nearest HostComponent down. It resets at every HostComponent level.
// 有 ViewTransition 组件、从 HostComponent 重置
export const ViewTransitionStatic = /*         */ 0b0000010000000000000000000000000;
// Tracks whether a HostPortal is present in the tree.
// 树中有 Portal
export const PortalStatic = /*                 */ 0b0000100000000000000000000000000;

// Flag used to identify newly inserted fibers. It isn't reset after commit unlike `Placement`.
// 开发环境标识新插入的 fiber、不同于 Placement，不会在 commit 后重置
export const PlacementDEV = /*                 */ 0b0001000000000000000000000000000;
// 开发环境 mount Layout effect
export const MountLayoutDev = /*               */ 0b0010000000000000000000000000000;
// 开发环境 mount Passive effect
export const MountPassiveDev = /*              */ 0b0100000000000000000000000000000;

// Groups of flags that are used in the commit phase to skip over trees that
// don't contain effects, by checking subtreeFlags.

// BeforeMutation 阶段需要处理的 flags
export const BeforeMutationMask: number =
  Snapshot |
  // 创建自定义事件处理函数，需要访问已删除和隐藏的子树
  // ChildDeletion → 触发 beforeblur  、Visibility → 焦点变化 、Update → 状态更新        
  (enableCreateEventHandleAPI
    ? // createEventHandle needs to visit deleted and hidden trees to
      // fire beforeblur
      // TODO: Only need to visit Deletions during BeforeMutation phase if an
      // element is focused.
      Update | ChildDeletion | Visibility
    : // useEffectEvent uses the snapshot phase,
      // but we're moving it to the mutation phase.
      enableEffectEventMutationPhase
      ? 0
      : Update);

// For View Transition support we use the snapshot phase to scan the tree for potentially
// affected ViewTransition components.
// View Transition 支持，BeforeMutation 和 AfterMutation 阶段使用
export const BeforeAndAfterMutationTransitionMask: number =
  Snapshot | Update | Placement | ChildDeletion | Visibility | ContentReset;

// Mutation 阶段需要处理的 flags
export const MutationMask =
  Placement |
  Update |
  ChildDeletion |
  ContentReset |
  Ref |
  Hydrating |
  Visibility |
  FormReset;

// Layout 阶段需要处理的 flags
export const LayoutMask = Update | Callback | Ref | Visibility;

// TODO: Split into PassiveMountMask and PassiveUnmountMask
// Passive 阶段需要处理的 flags
export const PassiveMask = Passive | Visibility | ChildDeletion;

// For View Transitions we need to visit anything we visited in the snapshot phase to
// restore the view-transition-name after committing the transition.
// View Transitions 需要，恢复 view-transition-name
export const PassiveTransitionMask: number = PassiveMask | Update | Placement;

// Union of tags that don't get reset on clones.
// This allows certain concepts to persist without recalculating them,
// e.g. whether a subtree contains passive effects or portals.
// StaticMask 是 React Fiber 标记系统中的位掩码常量，
// 标识在 Fiber 克隆时不需要重置的"静态"标记，这些标记的生命周期跨越多个渲染周期。
export const StaticMask =
  LayoutStatic | // 4194304 子树包含布局副作用
  PassiveStatic | // 8388608 子树包含被动副作用
  RefStatic | // 4194304 子树包含 ref 句柄
  MaySuspendCommit | // 16777216 子树包含视图过渡
  ViewTransitionStatic | // 33554432 子树包含 ViewTransition 组件
  ViewTransitionNamedStatic | // （ SnapshotStatic ｜MaySuspendCommit ） 子树包含命名视图过渡
  PortalStatic | // 67108864 子树包含 Portal 组件
  Forked; // 1048576 子树包含 Forked 标记
