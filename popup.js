'use strict';

const core = globalThis.ModHeadersCore;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
let state;
let revision = 0;
let saveTimer;
let dragState;
let undoTimer;
let pendingUndo;
let noticeTimer;
let scopeRenderRevision = 0;
let pendingNewProfilePattern = '';
let lastPersistError = '';
let lastSavedRevision = 0;
const filterValidationErrors = new Map();

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const elements = {};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value, label) {
  const node = element('option', '', label);
  node.value = value;
  return node;
}

function setStatus(message, type = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function setPowerUi(enabled) {
  elements.enabled.checked = enabled;
  elements.powerLabel.textContent = enabled ? 'On' : 'Off';
}

function setFiltersPowerUi(enabled) {
  elements.filtersEnabled.checked = enabled;
  elements.filtersPowerLabel.textContent = enabled ? 'enforced' : 'bypassed';
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function currentProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedProfileId)
    || state.profiles[0];
}

function changed({ render = false, immediate = false } = {}) {
  revision += 1;
  if (render) renderAll();
  clearTimeout(saveTimer);
  setStatus('Saving…', 'saving');
  if (immediate) persistNow();
  else saveTimer = setTimeout(persistNow, 350);
}

function renderedRowFor(itemId, rowClass) {
  return [...document.querySelectorAll(rowClass)]
    .find((row) => row.dataset.itemId === itemId);
}

async function validateStateBeforeSave() {
  const profile = currentProfile();
  for (const [area, headers] of [
    ['request', profile.requestHeaders],
    ['response', profile.responseHeaders]
  ]) {
    const invalid = headers.find((header) => header.enabled && header.name && !HEADER_NAME_RE.test(header.name));
    if (!invalid) continue;
    const row = renderedRowFor(invalid.id, `.header-row[data-area="${area}"]`);
    const input = row?.querySelector('[data-role="header-name"]');
    if (row && input) setFieldError(row, input, 'Use a valid HTTP header name without spaces.');
    return { ok: false, error: `Invalid ${area} header name.` };
  }

  if (!profile.filtersEnabled) return { ok: true };
  const filters = profile.filters.filter((filter) => (
    filter.enabled && filter.kind === 'url' && filter.pattern.trim()
  ));
  for (const filter of filters) {
    const regex = filter.patternType === 'wildcard'
      ? core.wildcardToRegex(filter.pattern.trim())
      : filter.pattern.trim();
    let message = '';
    let errorKind = 'syntax';
    try {
      new RegExp(regex);
    } catch (_error) {
      message = 'This regular expression is not valid.';
    }
    if (!message && typeof chrome.declarativeNetRequest?.isRegexSupported === 'function') {
      const result = await chrome.declarativeNetRequest.isRegexSupported({
        regex,
        isCaseSensitive: false
      });
      if (!result.isSupported) {
        errorKind = 'chrome';
        message = `Chrome cannot use this pattern${result.reason ? `: ${result.reason}` : '.'}`;
      }
    }
    if (message) filterValidationErrors.set(filter.id, { kind: errorKind, message });
    else filterValidationErrors.delete(filter.id);
    const row = renderedRowFor(filter.id, '.filter-row');
    const input = row?.querySelector('[data-role="url-pattern"]');
    if (row && input) setFieldError(row, input, message);
    if (message) {
      updateScopeSummary(profile);
      return { ok: false, error: message };
    }
  }
  return { ok: true };
}

async function persistNow() {
  clearTimeout(saveTimer);
  const capturedRevision = revision;
  lastPersistError = '';
  try {
    const validation = await validateStateBeforeSave();
    if (capturedRevision !== revision) return true;
    if (!validation.ok) throw new Error(validation.error);
    const snapshot = JSON.parse(JSON.stringify(state));
    const response = await sendMessage({ type: 'SAVE_STATE', state: snapshot });
    if (!response?.ok) throw new Error(response?.error || 'Chrome rejected the update.');
    lastSavedRevision = Math.max(lastSavedRevision, capturedRevision);
    if (capturedRevision === revision) {
      // Keep the live object graph used by the rendered event handlers. Replacing
      // it with the service worker's cloned response makes row buttons edit stale
      // arrays until the popup is rendered again.
      setStatus('Saved');
    }
    return true;
  } catch (error) {
    lastPersistError = error.message || 'Chrome rejected the change.';
    setStatus(`Couldn’t save · ${lastPersistError}`, 'error');
    document.querySelector('[aria-invalid="true"]')?.focus();
    return false;
  }
}

function flushStateOnExit() {
  clearTimeout(saveTimer);
  if (!state || revision <= lastSavedRevision) return;
  const snapshot = JSON.parse(JSON.stringify(state));
  lastSavedRevision = revision;
  try {
    chrome.runtime.sendMessage({ type: 'SAVE_STATE', state: snapshot });
  } catch (_error) {
    // The popup is already closing, so there is no useful UI for this failure.
  }
}

function bindValue(node, object, property, { immediate = false, transform } = {}) {
  const eventName = node.type === 'checkbox' || node.tagName === 'SELECT' ? 'change' : 'input';
  node.addEventListener(eventName, () => {
    let value = node.type === 'checkbox' ? node.checked : node.value;
    if (transform) value = transform(value, node);
    object[property] = value;
    changed({ immediate });
  });
}

function removeButton(onClick, label) {
  const button = element('button', 'icon-button small danger');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const lid = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lid.setAttribute('d', 'M5 6h10M8 6V4.5h4V6');
  const bin = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bin.setAttribute('d', 'M6.5 6.5l.6 9h5.8l.6-9M9 9v4M11 9v4');
  svg.append(lid, bin);
  button.append(svg);
  button.addEventListener('click', onClick);
  return button;
}

function closeMoreMenu() {
  elements.moreMenu.open = false;
}

function moveItem(items, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || toIndex >= items.length) return false;
  const [item] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, item);
  return true;
}

function finishDrag({ restore = false } = {}) {
  if (!dragState) return;
  dragState.preview?.remove();
  dragState.row.classList.remove('dragging');
  dragState.list.classList.remove('reordering');
  dragState = undefined;
  if (restore) renderAll();
}

function animateDraggedRowMove(list, beforeNode) {
  const row = dragState?.row;
  if (!row || beforeNode === row || row.nextSibling === beforeNode) return;
  for (const child of list.children) {
    if (child !== row) child.getAnimations().forEach((animation) => animation.cancel());
  }
  const previousPositions = new Map(
    [...list.children].map((child) => [child, child.getBoundingClientRect().top])
  );
  list.insertBefore(row, beforeNode);
  for (const child of list.children) {
    if (child === row) continue;
    const previousTop = previousPositions.get(child);
    const delta = previousTop === undefined ? 0 : previousTop - child.getBoundingClientRect().top;
    if (!delta) continue;
    child.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
      { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }
}

function createDragPreview(row, event) {
  const preview = row.cloneNode(true);
  preview.classList.remove('dragging');
  preview.classList.add('drag-preview');
  preview.setAttribute('aria-hidden', 'true');
  preview.style.width = `${row.getBoundingClientRect().width}px`;
  preview.querySelectorAll('input, select, button').forEach((control) => {
    control.tabIndex = -1;
  });
  document.body.append(preview);
  event.dataTransfer.setDragImage(preview, 22, 18);
  setTimeout(() => preview.remove(), 0);
  return preview;
}

function configureReorderableList(list, items, itemLabel) {
  list.ondragover = (event) => {
    if (!dragState || dragState.list !== list) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rows = [...list.children].filter((row) => row !== dragState.row);
    const beforeNode = rows.find((row) => {
      const bounds = row.getBoundingClientRect();
      return event.clientY < bounds.top + (bounds.height / 2);
    }) || null;
    animateDraggedRowMove(list, beforeNode);
  };

  list.ondrop = (event) => {
    if (!dragState || dragState.list !== list) return;
    event.preventDefault();
    const fromIndex = items.indexOf(dragState.item);
    const toIndex = [...list.children].indexOf(dragState.row);
    const moved = moveItem(items, fromIndex, toIndex);
    finishDrag();
    if (moved) {
      changed({ render: true });
      setStatus(`${itemLabel} moved to position ${toIndex + 1}`);
    }
  };
}

function dragHandle(list, items, item, itemLabel) {
  const handle = element('button', 'drag-handle');
  handle.type = 'button';
  handle.draggable = true;
  handle.title = 'Drag or use the arrow keys to reorder';
  handle.setAttribute('aria-label', `Reorder ${itemLabel}`);
  handle.append(element('span', 'grip-dots'));

  handle.addEventListener('dragstart', (event) => {
    const row = handle.closest('.header-row, .filter-row');
    const preview = createDragPreview(row, event);
    dragState = { list, items, item, row, preview };
    row.classList.add('dragging');
    list.classList.add('reordering');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  });
  handle.addEventListener('dragend', () => finishDrag({ restore: true }));
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const fromIndex = items.indexOf(item);
    const toIndex = Math.max(0, Math.min(items.length - 1,
      fromIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    if (!moveItem(items, fromIndex, toIndex)) return;
    changed({ render: true });
    list.children[toIndex]?.querySelector('.drag-handle')?.focus();
    setStatus(`${itemLabel} moved to position ${toIndex + 1}`);
  });
  return handle;
}

function enabledFilters(profile, kind) {
  if (!profile.filtersEnabled) return [];
  return profile.filters.filter((filter) => filter.enabled && filter.kind === kind);
}

function usableUrlFilters(profile) {
  return enabledFilters(profile, 'url').filter((filter) => (
    filter.pattern.trim() && !filterValidationErrors.has(filter.id)
  ));
}

function profileOptionLabel(profile) {
  return profile.title;
}

function exactWildcardHost(filter) {
  if (filter.patternType !== 'wildcard' || !filter.pattern.endsWith('/*')) return '';
  try {
    return new URL(filter.pattern.slice(0, -1)).host;
  } catch (_error) {
    return '';
  }
}

function urlFilterMatches(filter, url) {
  try {
    const pattern = filter.patternType === 'wildcard'
      ? core.wildcardToRegex(filter.pattern.trim())
      : filter.pattern.trim();
    return Boolean(pattern) && new RegExp(pattern, 'i').test(url);
  } catch (_error) {
    return false;
  }
}

function effectiveScope(profile) {
  if (!profile.filtersEnabled) {
    return {
      kind: 'bypassed',
      topText: 'Filters bypassed',
      cardTitle: 'Filters bypassed',
      detail: 'Saved filters are ignored. Active headers can apply to all websites.',
      meta: 'URL rules: Bypassed · Resource types: Bypassed',
      urls: [],
      resourceRows: [],
      resourceTypes: [],
      siteWide: true
    };
  }

  const urls = usableUrlFilters(profile);
  const resourceRows = enabledFilters(profile, 'resource');
  const resourceTypes = [...new Set(resourceRows.flatMap((filter) => filter.resourceTypes))];
  const resourceLabel = resourceRows.length === 0
    ? 'All'
    : resourceTypes.length > 0 ? `${resourceTypes.length} selected` : 'None';
  const meta = `URL rules: ${urls.length} · Resource types: ${resourceLabel}`;

  if (resourceRows.length > 0 && resourceTypes.length === 0) {
    return {
      kind: 'none',
      topText: 'No requests',
      cardTitle: 'Applying to: No requests',
      detail: 'Choose at least one resource type to activate this profile.',
      meta,
      urls,
      resourceRows,
      resourceTypes,
      siteWide: false
    };
  }
  if (urls.length === 0 && resourceRows.length > 0) {
    return {
      kind: 'resource',
      topText: 'Resource-limited',
      cardTitle: 'Applying to: Resource-limited requests',
      detail: 'Selected resource types can be modified on every website.',
      meta,
      urls,
      resourceRows,
      resourceTypes,
      siteWide: true
    };
  }
  if (urls.length === 0) {
    return {
      kind: 'all',
      topText: 'Applies to: All sites',
      cardTitle: 'Applying to: All websites',
      detail: 'Add a URL rule to limit where these headers are sent.',
      meta,
      urls,
      resourceRows,
      resourceTypes,
      siteWide: true
    };
  }

  const host = urls.length === 1 ? exactWildcardHost(urls[0]) : '';
  return {
    kind: host ? 'host' : 'urls',
    topText: host
      ? `Applies to: ${host}`
      : `${urls.length} URL ${urls.length === 1 ? 'rule' : 'rules'}`,
    cardTitle: host
      ? `Applying to: ${host}`
      : `Applying to: ${urls.length} URL ${urls.length === 1 ? 'rule' : 'rules'}`,
    detail: 'Checking whether the active page URL is included…',
    meta,
    urls,
    resourceRows,
    resourceTypes,
    host,
    siteWide: false
  };
}

function scopeShortLabel(scope) {
  if (scope.kind === 'all') return 'All sites';
  if (scope.kind === 'bypassed') return 'Bypassed';
  if (scope.kind === 'none') return 'No requests';
  if (scope.kind === 'resource') return 'Resource-limited';
  if (scope.kind === 'host') return scope.host;
  return `${scope.urls.length} URL ${scope.urls.length === 1 ? 'rule' : 'rules'}`;
}

function updateScopeWarning(profile, scope = effectiveScope(profile)) {
  const hasActiveHeaders = [...profile.requestHeaders, ...profile.responseHeaders]
    .some((header) => header.enabled && header.name.trim());
  elements.scopeWarning.hidden = !(state.enabled && hasActiveHeaders && scope.siteWide);
  if (elements.scopeWarning.hidden) return;
  elements.scopeWarning.textContent = scope.kind === 'bypassed'
    ? 'Filters are bypassed. Active headers can apply to every website.'
    : scope.kind === 'resource'
      ? 'Active headers can apply to every website for the selected resource types.'
      : 'Active headers currently apply to every website. Add a URL rule to limit exposure.';
}

function updateHeaderScopeSummary(profile, scope = effectiveScope(profile)) {
  elements.headerScopeSummary.textContent = state.enabled
    ? scope.topText
    : `Rules off · ${scopeShortLabel(scope)}`;
  elements.headerScopeSummary.classList.toggle('all-sites', state.enabled && scope.siteWide);
  elements.headerScopeSummary.title = !state.enabled
    ? 'Rules are off. Open filters.'
    : scope.siteWide
    ? 'This profile can affect every HTTP and HTTPS site. Open filters.'
    : 'Open filters';
}

async function updateScopeSummary(profile) {
  const renderRevision = ++scopeRenderRevision;
  const scope = effectiveScope(profile);

  const profileOption = [...elements.profileSelect.options]
    .find((item) => item.value === profile.id);
  if (profileOption) profileOption.textContent = profileOptionLabel(profile);
  updateHeaderScopeSummary(profile, scope);
  updateScopeWarning(profile, scope);
  elements.scopeSummaryTitle.textContent = state.enabled
    ? scope.cardTitle
    : `Configured scope: ${scopeShortLabel(scope)}`;
  elements.scopeSummaryDetail.textContent = state.enabled
    ? scope.detail
    : 'Rules are off. This scope will take effect when rules are enabled.';
  elements.scopeMeta.textContent = scope.meta;

  if (!state.enabled || (scope.kind !== 'host' && scope.kind !== 'urls')) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (renderRevision !== scopeRenderRevision || profile.id !== currentProfile().id) return;
    if (!tab?.url?.startsWith('http')) {
      elements.scopeSummaryDetail.textContent = 'The active page cannot be tested.';
      return;
    }
    const urlMatches = scope.urls.some((filter) => urlFilterMatches(filter, tab.url));
    const typeMatches = scope.resourceRows.length === 0 || scope.resourceTypes.includes('main_frame');
    const activeHost = new URL(tab.url).host;
    if (scope.urls.length === 1 && exactWildcardHost(scope.urls[0]) === activeHost) {
      elements.scopeSummaryTitle.textContent = `Current site: ${activeHost}`;
    }
    elements.scopeSummaryDetail.textContent = urlMatches && typeMatches
      ? 'This profile currently affects the active site.'
      : 'This profile does not affect the active site.';
  } catch (_error) {
    if (renderRevision === scopeRenderRevision) {
      elements.scopeSummaryDetail.textContent = 'The active page could not be checked.';
    }
  }
}

function setFieldError(row, input, message) {
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  let error = row.querySelector('.inline-error');
  if (!message) {
    error?.remove();
    return;
  }
  if (!error) {
    error = element('span', 'inline-error');
    row.append(error);
  }
  error.textContent = message;
}

function updateDuplicateHeaderWarnings(headers, list) {
  const lastEnabledIndex = new Map();
  headers.forEach((header, index) => {
    const name = header.enabled ? header.name.trim().toLowerCase() : '';
    if (name) lastEnabledIndex.set(name, index);
  });
  [...list.children].forEach((row, index) => {
    row.querySelector('.duplicate-warning')?.remove();
    const header = headers[index];
    const name = header?.enabled ? header.name.trim().toLowerCase() : '';
    if (!name || lastEnabledIndex.get(name) === index) return;
    row.append(element('span', 'inline-warning duplicate-warning', 'Overridden by a later enabled row'));
  });
}

function renderProfiles() {
  elements.profileSelect.replaceChildren();
  for (const profile of state.profiles) {
    elements.profileSelect.append(option(profile.id, profileOptionLabel(profile)));
  }
  elements.profileSelect.value = state.selectedProfileId;
  elements.profileDelete.disabled = state.profiles.length === 1;
  setPowerUi(state.enabled);
  const filtersEnabled = currentProfile().filtersEnabled;
  setFiltersPowerUi(filtersEnabled);
  elements.scopeCard.classList.toggle('filters-bypassed', !filtersEnabled);
  elements.theme.value = state.theme;
  updateHeaderScopeSummary(currentProfile());
}

function renderHeaders(area) {
  const profile = currentProfile();
  const headers = area === 'request' ? profile.requestHeaders : profile.responseHeaders;
  const list = area === 'request' ? elements.requestList : elements.responseList;
  const empty = area === 'request' ? elements.requestEmpty : elements.responseEmpty;
  const count = area === 'request' ? elements.requestCount : elements.responseCount;
  const labels = area === 'request' ? elements.requestLabels : elements.responseLabels;
  list.replaceChildren();
  empty.hidden = headers.length > 0;
  labels.hidden = headers.length === 0;
  count.textContent = String(headers.length);

  headers.forEach((header) => {
    const row = element('div', `header-row${header.enabled ? '' : ' disabled-row'}`);
    row.dataset.itemId = header.id;
    row.dataset.area = area;
    const handle = dragHandle(list, headers, header, `${area} header`);
    const enabled = element('input');
    enabled.type = 'checkbox';
    enabled.checked = header.enabled;
    enabled.setAttribute('aria-label', `Enable ${area} header`);
    enabled.addEventListener('change', () => {
      header.enabled = enabled.checked;
      row.classList.toggle('disabled-row', !header.enabled);
      updateScopeWarning(profile);
      updateDuplicateHeaderWarnings(headers, list);
      changed();
    });

    const name = element('input');
    name.value = header.name;
    name.placeholder = area === 'request' ? 'Authorization' : 'Access-Control-Allow-Origin';
    name.maxLength = 4096;
    name.setAttribute('aria-label', 'Header name');
    name.dataset.role = 'header-name';
    const validateName = () => {
      const invalid = name.value.trim() && !HEADER_NAME_RE.test(name.value.trim());
      setFieldError(row, name, invalid ? 'Use a valid HTTP header name without spaces.' : '');
    };
    name.addEventListener('input', () => {
      header.name = name.value;
      validateName();
      updateScopeWarning(profile);
      updateDuplicateHeaderWarnings(headers, list);
      changed();
    });

    const value = element('input');
    value.value = header.value;
    value.placeholder = 'Header value';
    value.maxLength = 4096;
    value.setAttribute('aria-label', 'Header value');
    bindValue(value, header, 'value');

    const comment = element('input');
    comment.value = header.comment;
    comment.placeholder = 'Local note';
    comment.maxLength = 10000;
    comment.setAttribute('aria-label', 'Header comment');
    bindValue(comment, header, 'comment');

    row.append(handle, enabled, name, value, comment, removeButton(() => {
      const label = header.name.trim()
        ? `${area} header “${header.name.trim()}”`
        : `${area} header`;
      deleteRowWithUndo(profile, headers, header, label);
    }, `Remove ${area} header`));
    validateName();
    list.append(row);
  });
  updateDuplicateHeaderWarnings(headers, list);
  configureReorderableList(list, headers, `${area[0].toUpperCase()}${area.slice(1)} header`);
}

function renderFilters() {
  const profile = currentProfile();
  const filters = profile.filters;
  elements.filterList.replaceChildren();
  elements.scopeHelp.hidden = filters.length === 0;
  elements.filterCount.textContent = String(filters.length);
  filters.forEach((filter) => {
    const row = element('div', `${filter.kind === 'resource' ? 'filter-row resource' : 'filter-row'}${filter.enabled ? '' : ' disabled-row'}`);
    row.dataset.itemId = filter.id;
    const handle = dragHandle(elements.filterList, filters, filter, 'filter');
    const enabled = element('input');
    enabled.type = 'checkbox';
    enabled.checked = filter.enabled;
    enabled.setAttribute('aria-label', 'Enable filter');
    enabled.addEventListener('change', () => {
      filter.enabled = enabled.checked;
      row.classList.toggle('disabled-row', !filter.enabled);
      updateScopeSummary(profile);
      changed();
    });
    const kind = element('span', 'filter-kind-label', filter.kind === 'resource' ? 'Resources' : 'URL');
    let validatePattern;
    row.append(handle, enabled, kind);

    if (filter.kind === 'url') {
      const patternType = element('select');
      patternType.append(option('regex', 'Regex'), option('wildcard', 'Wildcard'));
      patternType.value = filter.patternType;
      patternType.setAttribute('aria-label', 'URL pattern type');
      patternType.addEventListener('change', () => {
        filterValidationErrors.delete(filter.id);
        filter.patternType = patternType.value;
        changed({ render: true });
      });

      const pattern = element('input');
      pattern.value = filter.pattern;
      pattern.placeholder = filter.patternType === 'regex'
        ? '^https://api\\.example\\.com/'
        : 'https://*.example.com/*';
      pattern.maxLength = 4096;
      pattern.setAttribute('aria-label', 'URL pattern');
      pattern.dataset.role = 'url-pattern';
      validatePattern = () => {
        let message = '';
        if (filter.patternType === 'regex' && pattern.value.trim()) {
          try { new RegExp(pattern.value.trim()); } catch (_error) { message = 'This regular expression is not valid.'; }
        }
        if (message) filterValidationErrors.set(filter.id, { kind: 'syntax', message });
        else if (filterValidationErrors.get(filter.id)?.kind === 'syntax') filterValidationErrors.delete(filter.id);
        setFieldError(row, pattern, message);
      };
      pattern.addEventListener('input', () => {
        filterValidationErrors.delete(filter.id);
        filter.pattern = pattern.value;
        validatePattern();
        updateScopeSummary(profile);
        changed();
      });
      row.append(patternType, pattern);
    } else {
      const chips = element('div', 'resource-chip-list');
      for (const type of core.RESOURCE_TYPES) {
        const chip = element('label', 'resource-chip');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = filter.resourceTypes.includes(type);
        checkbox.setAttribute('aria-label', type.replaceAll('_', ' '));
        checkbox.addEventListener('change', () => {
          filter.resourceTypes = [...chips.querySelectorAll('input:checked')].map((item) => item.value);
          updateScopeSummary(profile);
          changed();
        });
        checkbox.value = type;
        chip.append(checkbox, element('span', '', type.replaceAll('_', ' ')));
        chips.append(chip);
      }
      row.append(chips);
    }

    row.append(removeButton(() => {
      filterValidationErrors.delete(filter.id);
      const label = filter.kind === 'resource'
        ? 'resource filter'
        : filter.pattern.trim() ? `URL filter “${filter.pattern.trim()}”` : 'URL filter';
      deleteRowWithUndo(profile, filters, filter, label);
    }, 'Remove filter'));
    elements.filterList.append(row);
    validatePattern?.();
  });
  configureReorderableList(elements.filterList, filters, 'Filter');
  updateScopeSummary(profile);
}

function renderAll() {
  renderProfiles();
  renderFilters();
  renderHeaders('request');
  renderHeaders('response');
}

function uniqueProfileTitle() {
  let index = state.profiles.length + 1;
  const titles = new Set(state.profiles.map((profile) => profile.title));
  while (titles.has(`Profile ${index}`)) index += 1;
  return `Profile ${index}`;
}

async function currentTabFilterPattern() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return core.filterPatternForUrl(tab?.url || '');
  } catch (_error) {
    return '';
  }
}

function setSectionExpanded(card, body, toggle, expanded) {
  body.hidden = !expanded;
  card.classList.toggle('collapsed', !expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  const sectionName = toggle === elements.requestToggle
    ? 'request headers'
    : toggle === elements.responseToggle ? 'response headers' : 'filters';
  toggle.title = `${expanded ? 'Collapse' : 'Expand'} ${sectionName}`;
  toggle.setAttribute('aria-label', toggle.title);
}

function openSection(card, body, toggle) {
  setSectionExpanded(card, body, toggle, true);
}

function bindSectionToggle(card, body, toggle) {
  toggle.addEventListener('click', () => {
    setSectionExpanded(card, body, toggle, toggle.getAttribute('aria-expanded') !== 'true');
  });
}

function focusCreatedRow(list, itemId, selector, { select = false } = {}) {
  requestAnimationFrame(() => {
    const row = [...list.children].find((item) => item.dataset.itemId === itemId);
    const control = row?.querySelector(selector);
    if (!row || !control) return;
    row.scrollIntoView({ block: 'nearest' });
    control.focus({ preventScroll: true });
    if (select && typeof control.select === 'function') control.select();
  });
}

function updateNewScopeChoiceUi() {
  for (const input of [elements.newScopeCurrent, elements.newScopeAll]) {
    input.closest('label').classList.toggle('selected', input.checked);
  }
}

async function openNewProfileDialog() {
  clearUndo();
  elements.profileAdd.disabled = true;
  elements.newProfileName.value = uniqueProfileTitle();
  elements.newScopeCurrentLabel.textContent = 'Detecting the active site…';
  try {
    pendingNewProfilePattern = await currentTabFilterPattern();
    elements.newScopeCurrent.disabled = !pendingNewProfilePattern;
    if (pendingNewProfilePattern) {
      const host = new URL(pendingNewProfilePattern.slice(0, -1)).host;
      elements.newScopeCurrent.checked = true;
      elements.newScopeCurrentLabel.textContent = host;
    } else {
      elements.newScopeAll.checked = true;
      elements.newScopeCurrentLabel.textContent = 'Unavailable on this browser page';
    }
    updateNewScopeChoiceUi();
    elements.newProfileDialog.showModal();
    elements.newProfileName.select();
  } finally {
    elements.profileAdd.disabled = false;
  }
}

function createNewProfileFromDialog() {
  const profile = core.createProfile(elements.newProfileName.value.trim() || uniqueProfileTitle());
  if (elements.newScopeCurrent.checked && pendingNewProfilePattern) {
    profile.filters.push(core.createFilter(pendingNewProfilePattern));
  }
  state.profiles.push(profile);
  state.selectedProfileId = profile.id;
  elements.newProfileDialog.close();
  openSection(elements.requestCard, elements.requestBody, elements.requestToggle);
  changed({ render: true, immediate: true });
}

function createResourceFilter() {
  const filter = core.createFilter();
  filter.kind = 'resource';
  filter.patternType = 'regex';
  filter.pattern = '';
  filter.resourceTypes = [];
  return filter;
}

function clearUndo() {
  clearTimeout(undoTimer);
  pendingUndo = undefined;
  elements.undoToast.hidden = true;
}

function showUndo(message, action) {
  clearTimeout(undoTimer);
  pendingUndo = action;
  elements.undoMessage.textContent = message;
  elements.undoToast.hidden = false;
  undoTimer = setTimeout(clearUndo, 7000);
}

function showNotice(message) {
  clearTimeout(noticeTimer);
  elements.noticeToast.textContent = message;
  elements.noticeToast.hidden = false;
  noticeTimer = setTimeout(() => {
    elements.noticeToast.hidden = true;
  }, 4000);
}

function deleteRowWithUndo(profile, items, item, label) {
  const index = items.indexOf(item);
  if (index < 0) return;
  items.splice(index, 1);
  showUndo(`Deleted ${label}`, () => {
    state.selectedProfileId = profile.id;
    items.splice(Math.min(index, items.length), 0, item);
  });
  changed({ render: true, immediate: true });
}

function deleteSelectedProfile() {
  if (state.profiles.length === 1) return;
  const index = state.profiles.findIndex((profile) => profile.id === state.selectedProfileId);
  const [deleted] = state.profiles.splice(index, 1);
  state.selectedProfileId = state.profiles[Math.max(0, index - 1)].id;
  showUndo(`Deleted “${deleted.title}”`, () => {
    state.profiles.splice(Math.min(index, state.profiles.length), 0, deleted);
    state.selectedProfileId = deleted.id;
  });
  closeMoreMenu();
  changed({ render: true, immediate: true });
}

function runUndo() {
  if (!pendingUndo) return;
  const action = pendingUndo;
  clearUndo();
  action();
  applyTheme(state.theme);
  changed({ render: true, immediate: true });
}

function updateImportSafetyUi() {
  const replacing = elements.importMode.value === 'replace';
  elements.replaceConfirmRow.hidden = !replacing;
  if (!replacing) elements.replaceConfirm.checked = false;
  elements.importSubmit.disabled = replacing && !elements.replaceConfirm.checked;
}

function previewImport() {
  elements.importError.textContent = '';
  const text = elements.importText.value.trim();
  if (!text) {
    elements.importPreview.textContent = 'Choose a backup to preview it.';
    updateImportSafetyUi();
    return;
  }
  try {
    const imported = core.normalizeState(text);
    const count = imported.profiles.length;
    elements.importPreview.textContent = elements.importMode.value === 'replace'
      ? `${count} ${count === 1 ? 'profile' : 'profiles'} will replace ${state.profiles.length} current ${state.profiles.length === 1 ? 'profile' : 'profiles'}.`
      : `${count} ${count === 1 ? 'profile' : 'profiles'} will be added. Existing profiles will stay unchanged.`;
  } catch (_error) {
    elements.importPreview.textContent = 'This backup is not ready to import.';
  }
  updateImportSafetyUi();
}

function resetImportDialog() {
  elements.importText.value = '';
  elements.importFile.value = '';
  elements.importMode.value = 'add';
  elements.replaceConfirm.checked = false;
  elements.importError.textContent = '';
  previewImport();
}

function downloadBackup(sourceState, prefix = 'header-studio-backup') {
  const backup = core.exportBackup(sourceState);
  const json = `${JSON.stringify(backup, null, 2)}\n`;
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = url;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  anchor.download = `${prefix}-${timestamp}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function redactedState(sourceState) {
  const redacted = JSON.parse(JSON.stringify(sourceState));
  for (const profile of redacted.profiles) {
    for (const header of [...profile.requestHeaders, ...profile.responseHeaders]) {
      if (header.value) header.value = '[REDACTED]';
      if (header.comment) header.comment = '[REDACTED]';
    }
  }
  return redacted;
}

function finishExport(sourceState, prefix, message) {
  downloadBackup(sourceState, prefix);
  elements.exportDialog.close();
  setStatus(message);
}

async function importBackup() {
  elements.importError.textContent = '';
  const text = elements.importText.value.trim();
  if (!text) {
    elements.importError.textContent = 'Paste backup JSON or choose a file.';
    return;
  }
  if (new Blob([text]).size > MAX_IMPORT_BYTES) {
    elements.importError.textContent = 'Backup is larger than the 2 MB safety limit.';
    return;
  }
  try {
    const imported = core.normalizeState(text);
    const replacing = elements.importMode.value === 'replace';
    if (replacing && !elements.replaceConfirm.checked) {
      throw new Error('Confirm that every current profile will be replaced.');
    }
    const previousState = JSON.parse(JSON.stringify(state));
    if (replacing) downloadBackup(previousState, 'header-studio-pre-import-backup');
    if (!replacing) {
      const availableSlots = 50 - state.profiles.length;
      if (availableSlots <= 0) throw new Error('Delete a profile before adding another backup.');
      const added = imported.profiles.slice(0, availableSlots).map((profile) => ({
        ...profile,
        id: core.createId('profile'),
        title: `${profile.title} (imported)`
      }));
      state.profiles.push(...added);
      state.selectedProfileId = added[0]?.id || state.selectedProfileId;
    } else {
      state = imported;
      applyTheme(state.theme);
    }
    revision += 1;
    setStatus('Saving…', 'saving');
    if (!await persistNow()) {
      state = previousState;
      applyTheme(state.theme);
      revision += 1;
      renderAll();
      elements.importError.textContent = lastPersistError
        ? `Couldn’t import: ${lastPersistError}`
        : 'Couldn’t import this backup.';
      return;
    }
    renderAll();
    elements.importDialog.close();
    resetImportDialog();
    if (replacing) {
      showUndo('Profiles replaced from backup', () => {
        state = previousState;
      });
    } else {
      clearUndo();
    }
    setStatus('Saved · Backup imported');
  } catch (error) {
    elements.importError.textContent = error.message || 'Invalid backup JSON.';
  }
}

function bindStaticEvents() {
  bindSectionToggle(elements.requestCard, elements.requestBody, elements.requestToggle);
  bindSectionToggle(elements.responseCard, elements.responseBody, elements.responseToggle);
  bindSectionToggle(elements.scopeCard, elements.scopeBody, elements.scopeToggle);
  elements.headerScopeSummary.addEventListener('click', () => {
    openSection(elements.scopeCard, elements.scopeBody, elements.scopeToggle);
    elements.scopeCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  elements.theme.addEventListener('change', () => {
    state.theme = elements.theme.value;
    applyTheme(state.theme);
    changed();
  });
  elements.enabled.addEventListener('change', () => {
    state.enabled = elements.enabled.checked;
    setPowerUi(state.enabled);
    updateScopeSummary(currentProfile());
    changed({ immediate: true });
  });
  elements.filtersEnabled.addEventListener('change', () => {
    const profile = currentProfile();
    profile.filtersEnabled = elements.filtersEnabled.checked;
    setFiltersPowerUi(profile.filtersEnabled);
    const hasActiveHeaders = [...profile.requestHeaders, ...profile.responseHeaders]
      .some((header) => header.enabled && header.name.trim());
    if (!profile.filtersEnabled && hasActiveHeaders) {
      showNotice('Filters bypassed — active headers will apply to all websites.');
    } else if (profile.filtersEnabled) {
      clearTimeout(noticeTimer);
      elements.noticeToast.hidden = true;
    }
    changed({ render: true, immediate: true });
  });
  elements.profileSelect.addEventListener('change', () => {
    state.selectedProfileId = elements.profileSelect.value;
    changed({ render: true, immediate: true });
  });
  elements.profileRename.addEventListener('click', () => {
    elements.profileTitle.value = currentProfile().title;
    closeMoreMenu();
    elements.renameDialog.showModal();
    elements.profileTitle.select();
  });
  elements.profileRenameSave.addEventListener('click', () => {
    currentProfile().title = elements.profileTitle.value.trim() || 'Untitled profile';
    elements.renameDialog.close();
    changed({ render: true });
  });
  elements.profileTitle.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    elements.profileRenameSave.click();
  });
  elements.profileAdd.addEventListener('click', openNewProfileDialog);
  elements.newScopeCurrent.addEventListener('change', updateNewScopeChoiceUi);
  elements.newScopeAll.addEventListener('change', updateNewScopeChoiceUi);
  elements.newProfileSubmit.addEventListener('click', createNewProfileFromDialog);
  elements.newProfileName.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    createNewProfileFromDialog();
  });
  elements.profileDelete.addEventListener('click', deleteSelectedProfile);
  elements.profileUndo.addEventListener('click', runUndo);
  elements.requestAdd.addEventListener('click', () => {
    openSection(elements.requestCard, elements.requestBody, elements.requestToggle);
    const header = core.createHeader();
    currentProfile().requestHeaders.push(header);
    changed({ render: true });
    focusCreatedRow(elements.requestList, header.id, '[data-role="header-name"]');
  });
  elements.responseAdd.addEventListener('click', () => {
    openSection(elements.responseCard, elements.responseBody, elements.responseToggle);
    const header = core.createHeader();
    currentProfile().responseHeaders.push(header);
    changed({ render: true });
    focusCreatedRow(elements.responseList, header.id, '[data-role="header-name"]');
  });
  elements.filterAdd.addEventListener('click', async () => {
    const profile = currentProfile();
    openSection(elements.scopeCard, elements.scopeBody, elements.scopeToggle);
    elements.filterAdd.disabled = true;
    try {
      const pattern = await currentTabFilterPattern();
      const filter = core.createFilter(pattern);
      profile.filters.push(filter);
      changed({ render: true });
      focusCreatedRow(elements.filterList, filter.id, '[data-role="url-pattern"]', { select: true });
    } finally {
      elements.filterAdd.disabled = false;
    }
  });
  elements.resourceFilterAdd.addEventListener('click', () => {
    openSection(elements.scopeCard, elements.scopeBody, elements.scopeToggle);
    const filter = createResourceFilter();
    currentProfile().filters.push(filter);
    changed({ render: true });
    focusCreatedRow(elements.filterList, filter.id, '.resource-chip input');
  });
  elements.exportButton.addEventListener('click', () => {
    closeMoreMenu();
    elements.exportDialog.showModal();
  });
  elements.exportFull.addEventListener('click', () => {
    finishExport(state, 'header-studio-backup', 'Full backup exported');
  });
  elements.exportRedacted.addEventListener('click', () => {
    finishExport(redactedState(state), 'header-studio-redacted-backup', 'Redacted backup exported');
  });
  elements.importOpen.addEventListener('click', () => {
    closeMoreMenu();
    resetImportDialog();
    elements.importDialog.showModal();
  });
  elements.importSubmit.addEventListener('click', importBackup);
  elements.importText.addEventListener('input', previewImport);
  elements.importMode.addEventListener('change', previewImport);
  elements.replaceConfirm.addEventListener('change', updateImportSafetyUi);
  elements.importFile.addEventListener('change', async () => {
    const file = elements.importFile.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      elements.importError.textContent = 'Backup is larger than the 2 MB safety limit.';
      elements.importFile.value = '';
      return;
    }
    elements.importText.value = await file.text();
    previewImport();
  });
  document.addEventListener('click', (event) => {
    if (elements.moreMenu.open && !elements.moreMenu.contains(event.target)) closeMoreMenu();
  });
}

async function initialize() {
  const ids = {
    enabled: 'enabled', theme: 'theme', profileSelect: 'profile-select', profileTitle: 'profile-title',
    headerScopeSummary: 'header-scope-summary',
    profileAdd: 'profile-add', profileDelete: 'profile-delete', profileRename: 'profile-rename',
    profileRenameSave: 'profile-rename-save', renameDialog: 'rename-dialog', moreMenu: 'more-menu',
    requestAdd: 'request-add', requestCard: 'request-card', requestBody: 'request-body',
    requestToggle: 'request-toggle', responseCard: 'response-card', responseBody: 'response-body',
    responseToggle: 'response-toggle', scopeBody: 'scope-body', scopeToggle: 'scope-toggle',
    responseAdd: 'response-add', filterAdd: 'filter-add', requestList: 'request-list',
    resourceFilterAdd: 'resource-filter-add', requestCount: 'request-count', responseCount: 'response-count',
    filterCount: 'filter-count',
    requestLabels: 'request-labels', responseLabels: 'response-labels',
    responseList: 'response-list', filterList: 'filter-list', requestEmpty: 'request-empty',
    responseEmpty: 'response-empty', scopeHelp: 'scope-help', status: 'status', powerLabel: 'power-label',
    filtersEnabled: 'filters-enabled', filtersPowerLabel: 'filters-power-label',
    scopeCard: 'scope-card', scopeSummaryTitle: 'scope-summary-title',
    scopeSummaryDetail: 'scope-summary-detail', scopeMeta: 'scope-meta', scopeWarning: 'scope-warning',
    undoToast: 'undo-toast', undoMessage: 'undo-message', profileUndo: 'profile-undo',
    noticeToast: 'notice-toast',
    newProfileDialog: 'new-profile-dialog', newProfileName: 'new-profile-name',
    newProfileSubmit: 'new-profile-submit', newScopeCurrent: 'new-scope-current',
    newScopeAll: 'new-scope-all', newScopeCurrentLabel: 'new-scope-current-label',
    exportButton: 'export', exportDialog: 'export-dialog', exportFull: 'export-full',
    exportRedacted: 'export-redacted', importOpen: 'import-open', importDialog: 'import-dialog',
    importText: 'import-text', importFile: 'import-file', importMode: 'import-mode',
    importError: 'import-error', importSubmit: 'import-submit', importPreview: 'import-preview',
    replaceConfirmRow: 'replace-confirm-row', replaceConfirm: 'replace-confirm'
  };
  for (const [key, id] of Object.entries(ids)) elements[key] = document.getElementById(id);
  try {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (!response?.ok) throw new Error(response?.error || 'Could not load settings.');
    state = core.normalizeState(response.state);
    let initializedScope = false;
    if (state.initialScopePending) {
      const pattern = await currentTabFilterPattern();
      state.initialScopePending = false;
      if (pattern) currentProfile().filters.push(core.createFilter(pattern));
      revision += 1;
      initializedScope = true;
    }
    applyTheme(state.theme);
    renderAll();
    if (currentProfile().responseHeaders.length === 0) {
      setSectionExpanded(elements.responseCard, elements.responseBody, elements.responseToggle, false);
    }
    if (initializedScope) await persistNow();
    else setStatus('Saved');
  } catch (error) {
    state = core.createDefaultState();
    applyTheme(state.theme);
    renderAll();
    setStatus(error.message || 'Could not load settings.', 'error');
  }
  bindStaticEvents();
}

document.addEventListener('DOMContentLoaded', initialize);
window.addEventListener('blur', () => {
  if (state && revision > lastSavedRevision) persistNow();
});
window.addEventListener('pagehide', flushStateOnExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushStateOnExit();
});
