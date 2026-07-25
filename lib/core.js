(function initCore(global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_PROFILES = 50;
  const MAX_HEADERS = 200;
  const MAX_FILTERS = 100;
  const MAX_TEXT = 4096;
  const MAX_COMMENT = 10000;
  const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  const RESOURCE_TYPES = Object.freeze([
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
    'websocket', 'webtransport', 'webbundle', 'other'
  ]);

  function createId(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return `${prefix}-${global.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function cleanString(value, maxLength = MAX_TEXT) {
    if (value === undefined || value === null) return '';
    return String(value).slice(0, maxLength);
  }

  function asBoolean(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function createHeader() {
    return {
      id: createId('header'),
      enabled: true,
      name: '',
      value: '',
      comment: ''
    };
  }

  function createFilter(pattern = '') {
    return {
      id: createId('filter'),
      enabled: true,
      kind: 'url',
      patternType: pattern ? 'wildcard' : 'regex',
      pattern: cleanString(pattern),
      resourceTypes: []
    };
  }

  function filterPatternForUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return `${url.origin}/*`;
    } catch (_error) {
      return '';
    }
  }

  function hasActiveHeaders(profile) {
    return [...(profile?.requestHeaders || []), ...(profile?.responseHeaders || [])]
      .some((header) => header.enabled && HEADER_NAME_RE.test(header.name));
  }

  function createProfile(title = 'Profile 1') {
    return {
      id: createId('profile'),
      title: cleanString(title, 120) || 'Untitled profile',
      filtersEnabled: true,
      requestHeaders: [],
      responseHeaders: [],
      filters: []
    };
  }

  function createDefaultState() {
    const profile = createProfile();
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: true,
      theme: 'system',
      initialScopePending: true,
      selectedProfileId: profile.id,
      profiles: [profile]
    };
  }

  function normalizeHeader(raw, index, prefix) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      id: cleanString(source.id, 160) || `${prefix}-header-${index}`,
      enabled: asBoolean(source.enabled),
      name: cleanString(source.name).trim(),
      value: cleanString(source.value),
      comment: cleanString(source.comment, MAX_COMMENT)
    };
  }

  function normalizeFilter(raw, index, prefix) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const legacyType = source.type;
    const kind = source.kind === 'resource' || legacyType === 'types'
      ? 'resource'
      : 'url';
    let pattern = source.pattern;
    let patternType = source.patternType === 'wildcard' ? 'wildcard' : 'regex';
    if (pattern === undefined && source.urlRegex !== undefined) {
      pattern = source.urlRegex;
      patternType = 'regex';
    } else if (pattern === undefined && source.urlPattern !== undefined) {
      pattern = source.urlPattern;
      patternType = 'wildcard';
    }
    const rawTypes = Array.isArray(source.resourceTypes)
      ? source.resourceTypes
      : Array.isArray(source.resourceType) ? source.resourceType : [];
    const resourceTypes = [...new Set(rawTypes.filter((type) => RESOURCE_TYPES.includes(type)))];
    return {
      id: cleanString(source.id, 160) || `${prefix}-filter-${index}`,
      enabled: asBoolean(source.enabled),
      kind,
      patternType,
      pattern: cleanString(pattern),
      resourceTypes
    };
  }

  function normalizeProfile(raw, index) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const prefix = cleanString(source.id, 160) || `profile-${index}`;
    const requestSource = Array.isArray(source.requestHeaders)
      ? source.requestHeaders
      : Array.isArray(source.headers) ? source.headers : [];
    const responseSource = Array.isArray(source.responseHeaders)
      ? source.responseHeaders
      : Array.isArray(source.respHeaders) ? source.respHeaders : [];
    const filters = Array.isArray(source.filters) ? source.filters : [];
    const urlFilters = Array.isArray(source.urlFilters)
      ? source.urlFilters.map((filter) => ({ ...filter, kind: 'url' }))
      : [];
    const legacyResourceFilters = Array.isArray(source.resourceTypeFilters)
      ? source.resourceTypeFilters
      : Array.isArray(source.resourceFilters) ? source.resourceFilters : [];
    const resourceFilters = legacyResourceFilters
      .map((filter) => ({ ...filter, kind: 'resource' }));
    const filterSource = [...filters, ...urlFilters, ...resourceFilters];
    return {
      id: prefix,
      title: cleanString(source.title, 120).trim() || `Profile ${index + 1}`,
      filtersEnabled: asBoolean(source.filtersEnabled),
      requestHeaders: requestSource.slice(0, MAX_HEADERS)
        .map((header, headerIndex) => normalizeHeader(header, headerIndex, prefix)),
      responseHeaders: responseSource.slice(0, MAX_HEADERS)
        .map((header, headerIndex) => normalizeHeader(header, headerIndex, prefix)),
      filters: filterSource.slice(0, MAX_FILTERS)
        .map((filter, filterIndex) => normalizeFilter(filter, filterIndex, prefix))
    };
  }

  function unwrapImport(raw) {
    let value = raw;
    for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
      value = JSON.parse(value);
    }
    if (Array.isArray(value)) return { profiles: value };
    if (!value || typeof value !== 'object') {
      throw new Error('Backup must contain a JSON object, profile, or profile array.');
    }
    if (Array.isArray(value.profiles)) return value;
    if (value.state && typeof value.state === 'object') return unwrapImport(value.state);
    if (Array.isArray(value.headers) || Array.isArray(value.requestHeaders)) {
      return { profiles: [value] };
    }
    throw new Error('No profiles were found in this backup.');
  }

  function normalizeState(raw) {
    let source;
    try {
      source = unwrapImport(raw);
    } catch (error) {
      if (raw === undefined || raw === null) return createDefaultState();
      throw error;
    }
    const profiles = source.profiles.slice(0, MAX_PROFILES)
      .map((profile, index) => normalizeProfile(profile, index));
    if (profiles.length === 0) return createDefaultState();

    const ids = new Set();
    for (const profile of profiles) {
      let candidate = profile.id;
      let suffix = 2;
      while (ids.has(candidate)) candidate = `${profile.id}-${suffix++}`;
      profile.id = candidate;
      ids.add(candidate);
    }

    let selectedProfileId = cleanString(source.selectedProfileId, 160);
    if (!ids.has(selectedProfileId) && Number.isInteger(Number(source.selectedProfile))) {
      selectedProfileId = profiles[Number(source.selectedProfile)]?.id || '';
    }
    if (!ids.has(selectedProfileId)) selectedProfileId = profiles[0].id;
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: asBoolean(source.enabled),
      theme: ['system', 'light', 'dark'].includes(source.theme) ? source.theme : 'system',
      initialScopePending: source.initialScopePending === true,
      selectedProfileId,
      profiles
    };
  }

  function wildcardToRegex(pattern) {
    let output = '^';
    for (const character of pattern) {
      if (character === '*') output += '.*';
      else if (character === '?') output += '.';
      else output += character.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    }
    return `${output}$`;
  }

  function compileHeaderActions(headers, area) {
    const byName = new Map();
    for (const header of headers) {
      if (!header.enabled || !header.name) continue;
      if (!HEADER_NAME_RE.test(header.name)) {
        throw new Error(`Invalid ${area} header name: ${header.name}`);
      }
      const key = header.name.toLowerCase();
      const item = { header: header.name, operation: 'set', value: header.value };
      byName.set(key, item);
    }
    return [...byName.values()];
  }

  function compileProfile(profile) {
    if (!profile) throw new Error('The selected profile does not exist.');
    const requestHeaders = compileHeaderActions(profile.requestHeaders, 'request');
    const responseHeaders = compileHeaderActions(profile.responseHeaders, 'response');
    if (requestHeaders.length === 0 && responseHeaders.length === 0) {
      return { rules: [], regexes: [], activeHeaderCount: 0 };
    }

    const enabledFilters = profile.filtersEnabled === false
      ? []
      : profile.filters.filter((filter) => filter.enabled);
    const urlFilters = enabledFilters.filter((filter) => filter.kind === 'url' && filter.pattern.trim());
    const resourceFilters = enabledFilters.filter((filter) => filter.kind === 'resource');
    const resourceTypes = [...new Set(resourceFilters.flatMap((filter) => filter.resourceTypes))];
    if (resourceFilters.length > 0 && resourceTypes.length === 0) {
      return { rules: [], regexes: [], activeHeaderCount: requestHeaders.length + responseHeaders.length };
    }
    // Chrome excludes main-frame navigations when both resourceTypes and
    // excludedResourceTypes are omitted. Be explicit so an unrestricted rule
    // really applies to every supported request type, including a URL opened
    // directly in a tab.
    const matchingResourceTypes = resourceTypes.length > 0 ? resourceTypes : RESOURCE_TYPES;

    const regexes = urlFilters.map((filter) => filter.patternType === 'wildcard'
      ? wildcardToRegex(filter.pattern.trim())
      : filter.pattern.trim());
    const conditions = regexes.length > 0
      ? regexes.map((regexFilter) => ({ regexFilter }))
      : [{}];
    const rules = conditions.map((condition, index) => {
      condition.resourceTypes = matchingResourceTypes;
      const action = { type: 'modifyHeaders' };
      if (requestHeaders.length > 0) action.requestHeaders = requestHeaders;
      if (responseHeaders.length > 0) action.responseHeaders = responseHeaders;
      return { id: index + 1, priority: 1, action, condition };
    });
    return {
      rules,
      regexes,
      activeHeaderCount: requestHeaders.length + responseHeaders.length
    };
  }

  function exportBackup(state) {
    const normalized = normalizeState(state);
    return {
      format: 'header-studio-backup',
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      ...normalized
    };
  }

  const api = Object.freeze({
    RESOURCE_TYPES,
    SCHEMA_VERSION,
    compileProfile,
    createDefaultState,
    createFilter,
    createHeader,
    createId,
    createProfile,
    exportBackup,
    filterPatternForUrl,
    hasActiveHeaders,
    normalizeState,
    wildcardToRegex
  });

  global.ModHeadersCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
