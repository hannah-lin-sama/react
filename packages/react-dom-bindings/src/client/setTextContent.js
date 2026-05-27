/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {TEXT_NODE} from './HTMLNodeType';

/**
 * Set the textContent property of a node. For text updates, it's faster
 * to set the `nodeValue` of the Text node directly instead of using
 * `.textContent` which will remove the existing node and create a new one.
 *
 * @param {DOMElement} node
 * @param {string} text
 * @internal
 */
function setTextContent(node: Element, text: string): void {
  if (text) {
    const firstChild = node.firstChild;

    // 如果只有一个子节点，且是文本节点，直接设置文本内容
    if (
      firstChild &&
      firstChild === node.lastChild &&
      firstChild.nodeType === TEXT_NODE
    ) {
      //
      firstChild.nodeValue = text;
      return;
    }
  }
  // 其他情况，直接设置文本内容
  node.textContent = text;
}

export default setTextContent;
