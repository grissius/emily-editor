import React from 'react';
const { JSDOM } = require('jsdom');

export const getDocument = (html) => new JSDOM(html).window.document;

export const indexOfLine = (str, ln) => str.split('\n').slice(0, ln).join('\n').length;

export const findHeadersFromNinjaHtml = (html, raw) => {
  const document = getDocument(html);
  const selector = [...Array(6).keys()].map(n => `h${n+1}>strong[data-line]`).join(',');
  const nodes = [...document.querySelectorAll(selector)].map((ninja, index) => {
    const heading = ninja.parentNode;
    heading.removeChild(ninja);
    const level = Number(heading.tagName.slice(1));
    const content = heading.textContent;
    const html = heading.innerHTML;
    const ln = Number(ninja.dataset.line);
    const pos = indexOfLine(raw, ln - 1)
    return {level, content, html, ln, heading, pos, index};
  });
  return nodes;
}

// Find nth occurance of needle in haystack
export const nthIndexOf = (haystack, needle, n = 1) => haystack
  .split(needle, n)
  .join(needle)
  .length;

// Find next sibling in LML heading hierarchy
// That first next with greater or equal level
export const findNextSibling = (heading) => {
  if (!heading) {
    return null;
  }
  let currentNode = heading.next;
  while (currentNode && currentNode.level > heading.level) {
    currentNode = currentNode.next;
  }
  return currentNode;
};

// Find top offset of node, relative to container
// Note that container needs to have position relative or absolute
export const findRelativeOffset = (node, container) => {
  // container must have position absolute or relative
  let currentNode = node;
  const nodes = [];
  while (currentNode && currentNode.offsetParent && currentNode !== container) {
    nodes.push(currentNode);
    currentNode = currentNode.offsetParent;
  }
  return nodes.reduce((acc, v) => acc + v.offsetTop, 0);
};

// Move substring defined by cut indices to pasteIndex in ginven string
export const moveSubstring = (string, cutStartIndex, cutEndIndex, _pasteIndex) => {
  const cutted = string.slice(cutStartIndex, cutEndIndex);
  const holed = [
    string.slice(0, cutStartIndex),
    string.slice(cutEndIndex),
  ].join('');
  let pasteIndex = _pasteIndex;
  if (cutEndIndex <= pasteIndex) {
    pasteIndex -= (cutEndIndex - cutStartIndex);
  }
  return [
    holed.slice(0, pasteIndex),
    cutted,
    holed.slice(pasteIndex),
  ].join('');
};

// Find headers in source code using headerRegex
const findHeaders = (source, toHtml, headerRegex) => {
  const dupIndexMap = {};
  return (source.match(headerRegex) || []).map((headerSource, index) => {
    dupIndexMap[headerSource] = (dupIndexMap[headerSource] || 0) + 1;
    const html = toHtml(headerSource);
    const matches = html.match(/<h([0-9])[^<>]*>(.*)<\/h[0-9]>/);
    // false-friend header (not really a header)
    if (!matches) return null;
    const [, level, content] = matches;
    return {
      source: headerSource,
      html,
      level: Number(level),
      content,
      index,
      dupIndex: dupIndexMap[headerSource],
    };
  })
    // trash false-friend headers
    .filter(header => header !== null);
};

export const generateOutline = (html, source, toHtml, headerRegex) => {
  const headers = findHeadersFromNinjaHtml(html, source)
    .map(heading => ({
      ...heading,
      children: [],
      path: [],
      parent: null,
    }));
  headers.forEach((heading, i) => {
    const prev = headers[i - 1] || null;
    const next = headers[i + 1] || null;
    headers[i].prev = prev;
    headers[i].next = next;
  });
  const outline = headers
    .reduce((acc, val) => {
      const last = arr => arr[arr.length - 1] || null;
      const insert = (into, what) => {
        if (into.children.length === 0 || what.level - into.level === 1) {
          if (what.level === into.level) {
            into.parent.children.push(what);
          } else {
            // TODO DRY
            into.children.push({
              ...what,
              parent: into,
              path: [...what.path, into.children.length],
            });
          }
        } else if (into.level < what.level) {
          insert(last(into.children), {
            ...what,
            parent: into,
            path: [...what.path, into.children.length - 1],
          });
        } else {
          // TODO DRY
          into.children.push({
            ...what,
            parent: into,
            path: [...what.path, into.children.length],
          });
        }
      };
      const lastHeading = last(acc);
      const lastLevel = lastHeading ? lastHeading.level : 1;
      if (acc.length === 0 || val.level <= lastLevel) {
        acc.push({ ...val, path: [Math.max(acc.length, 1) - 1] });
      } else {
        insert(lastHeading, { ...val, path: [acc.length - 1] }, acc);
      }
      return acc;
    }, []);
  return outline;
};


export const findWordBounds = (string, index) => [
  index - string.slice(0, index)
    .split('').reverse().join('')
    .split(/\W/)[0].length,
  index + string.slice(index).split(/\W/)[0].length,
];


export const formatShortcut = ({ win, mac }, plaintext = false) => {
  const binding = (
    typeof navigator !== 'undefined' && navigator.platform.match(/(Mac|iPhone|iPod|iPad)/i) ? mac : win
  ).split('-');
  if (plaintext) {
    return binding.join(' + ');
  }
  return binding.map(key => <kbd key={key}>{key}</kbd>).reduce((acc, v) => [acc, ' + ', v]);
};

export const applyOnDom = (htmlString, fn) => {
  if (typeof document !== 'undefined') {
    const htmlDom = document.createElement('div');
    htmlDom.innerHTML = htmlString;
    fn(htmlDom);
    return htmlDom.innerHTML;
  }
  return htmlString;
};
