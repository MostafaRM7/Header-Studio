'use strict';

importScripts('lib/core.js');

const STATE_KEY = 'headerStudioState';
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const core = globalThis.ModHeadersCore;
let updateQueue = Promise.resolve();

async function readState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return core.normalizeState(stored[STATE_KEY]);
}

async function validateRegexes(regexes) {
  if (typeof chrome.declarativeNetRequest.isRegexSupported !== 'function') return;
  for (const regex of regexes) {
    const result = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: false
    });
    if (!result.isSupported) {
      throw new Error(`Unsupported URL regular expression: ${result.reason || regex}`);
    }
  }
}

async function replaceRules(rules) {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: current.map((rule) => rule.id),
    addRules: rules
  });
}

async function updateBadge(state, activeHeaderCount) {
  const badgeText = state.enabled
    ? activeHeaderCount > 0 ? String(Math.min(activeHeaderCount, 999)) : ''
    : 'OFF';
  await chrome.action.setBadgeBackgroundColor({
    color: state.enabled ? '#3764e8' : '#b42318'
  });
  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setTitle({
    title: state.enabled ? 'Header Studio (on)' : 'Header Studio (off)'
  });
}

async function applyState(rawState, persist = true) {
  const state = core.normalizeState(rawState);
  const stateBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (stateBytes > MAX_STATE_BYTES) {
    throw new Error('Settings exceed the 5 MB local safety limit. Remove unused profiles or comments.');
  }
  const profile = state.profiles.find((item) => item.id === state.selectedProfileId);
  const compiled = core.compileProfile(profile);
  if (state.enabled) await validateRegexes(compiled.regexes);
  await replaceRules(state.enabled ? compiled.rules : []);
  if (persist) await chrome.storage.local.set({ [STATE_KEY]: state });
  await updateBadge(state, compiled.activeHeaderCount);
  return state;
}

function serializeUpdate(task) {
  const next = updateQueue.then(task, task);
  updateQueue = next.catch(() => undefined);
  return next;
}

async function initialize() {
  try {
    const state = await readState();
    await applyState(state, true);
  } catch (error) {
    console.error('Header Studio failed to initialize:', error);
    await replaceRules([]);
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  }
}

chrome.runtime.onInstalled.addListener(() => serializeUpdate(initialize));
chrome.runtime.onStartup.addListener(() => serializeUpdate(initialize));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'GET_STATE') {
    readState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'SAVE_STATE') {
    serializeUpdate(() => applyState(message.state, true))
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

serializeUpdate(initialize);
