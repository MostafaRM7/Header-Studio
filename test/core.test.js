'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.js');

test('creates a usable default state', () => {
  const state = core.createDefaultState();
  assert.equal(state.enabled, true);
  assert.equal(state.theme, 'system');
  assert.equal(state.initialScopePending, true);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.selectedProfileId, state.profiles[0].id);
  assert.equal(state.profiles[0].requestHeaders.length, 0);
  assert.equal(state.profiles[0].filtersEnabled, true);
});

test('normalizes persisted theme choices and defaults invalid themes to system', () => {
  const base = { profiles: [{ title: 'Theme', headers: [] }] };
  assert.equal(core.normalizeState({ ...base, theme: 'dark' }).theme, 'dark');
  assert.equal(core.normalizeState({ ...base, theme: 'light' }).theme, 'light');
  assert.equal(core.normalizeState({ ...base, theme: 'sepia' }).theme, 'system');
});

test('only fresh default state requests initial active-site scoping', () => {
  const existing = core.normalizeState({ profiles: [{ title: 'Existing', headers: [] }] });
  const pending = core.normalizeState({
    initialScopePending: true,
    profiles: [{ title: 'Fresh', headers: [] }]
  });
  assert.equal(existing.initialScopePending, false);
  assert.equal(pending.initialScopePending, true);
});

test('imports a legacy ModHeader profile and preserves comments', () => {
  const legacy = JSON.stringify({
    title: 'Legacy API',
    headers: [{ enabled: true, name: 'X-Token', value: 'abc', comment: 'staging only' }],
    respHeaders: [{ enabled: true, name: 'X-Frame-Options', value: '', comment: 'empty value' }],
    filters: [
      { enabled: true, type: 'urls', urlRegex: '^https://api\\.example\\.com/' },
      { enabled: true, type: 'types', resourceType: ['xmlhttprequest', 'script'] }
    ]
  });
  const state = core.normalizeState(legacy);
  const profile = state.profiles[0];
  assert.equal(profile.title, 'Legacy API');
  assert.equal(profile.requestHeaders[0].comment, 'staging only');
  assert.equal(profile.responseHeaders[0].value, '');
  assert.deepEqual(profile.filters[1].resourceTypes, ['xmlhttprequest', 'script']);
  assert.equal(profile.filters[0].pattern, '^https://api\\.example\\.com/');
});

test('imports version 2 ModHeader urlFilters and resourceTypeFilters', () => {
  const backup = [{
    version: 2,
    title: 'Profile 1',
    headers: [{ enabled: true, name: 'Authorization', value: 'sanitized', comment: 'Financial' }],
    urlFilters: [
      { enabled: true, urlRegex: '.*://127\\.0\\.0\\.1:8000/.*' },
      { enabled: true, urlRegex: '.*://wallet\\.example\\.com/.*' }
    ],
    resourceTypeFilters: [
      { enabled: true, resourceType: ['xmlhttprequest', 'script'] }
    ]
  }];
  const state = core.normalizeState(JSON.stringify(backup));
  const profile = state.profiles[0];
  assert.equal(profile.filters.length, 3);
  assert.deepEqual(
    profile.filters.map((filter) => filter.kind),
    ['url', 'url', 'resource']
  );
  assert.equal(profile.filters[0].pattern, '.*://127\\.0\\.0\\.1:8000/.*');
  assert.deepEqual(profile.filters[2].resourceTypes, ['xmlhttprequest', 'script']);

  const compiled = core.compileProfile(profile);
  assert.equal(compiled.rules.length, 2);
  assert.deepEqual(compiled.rules[0].condition.resourceTypes, ['xmlhttprequest', 'script']);
});

test('imports a legacy profile array and selected numeric index', () => {
  const state = core.normalizeState({
    selectedProfile: 1,
    profiles: [
      { title: 'First', headers: [] },
      { title: 'Second', headers: [] }
    ]
  });
  assert.equal(state.profiles.length, 2);
  assert.equal(state.selectedProfileId, state.profiles[1].id);
});

test('unwraps a JSON-stringified backup stored inside JSON', () => {
  const nested = JSON.stringify(JSON.stringify({
    profiles: [{ title: 'Nested', headers: [] }]
  }));
  assert.equal(core.normalizeState(nested).profiles[0].title, 'Nested');
});

test('rejects input without profiles', () => {
  assert.throws(() => core.normalizeState('{"unrelated":true}'), /No profiles/);
});

test('converts wildcards to an anchored safe regex', () => {
  assert.equal(
    core.wildcardToRegex('https://*.example.com/api?x=*'),
    '^https:\\/\\/.*\\.example\\.com\\/api.x=.*$'
  );
});

test('builds a wildcard filter from the current tab origin', () => {
  assert.equal(
    core.filterPatternForUrl('https://api.example.com:8443/orders/42?draft=true#notes'),
    'https://api.example.com:8443/*'
  );
  assert.equal(core.filterPatternForUrl('chrome://extensions/'), '');
  assert.equal(core.filterPatternForUrl('not a URL'), '');
  const filter = core.createFilter('https://api.example.com/*');
  assert.equal(filter.patternType, 'wildcard');
  assert.equal(filter.pattern, 'https://api.example.com/*');
});

test('compiles URL filters as OR and resource filters as an AND group', () => {
  const profile = core.createProfile('Compile');
  profile.requestHeaders = [
    { id: 'a', enabled: true, name: 'X-Test', value: 'one', comment: 'not emitted' }
  ];
  profile.responseHeaders = [
    { id: 'b', enabled: true, name: 'Server', value: '', comment: '' }
  ];
  profile.filters = [
    { id: 'u1', enabled: true, kind: 'url', patternType: 'regex', pattern: '^https://one\\.' },
    { id: 'u2', enabled: true, kind: 'url', patternType: 'wildcard', pattern: 'https://two.example/*' },
    { id: 'r1', enabled: true, kind: 'resource', resourceTypes: ['script', 'xmlhttprequest'] }
  ];
  const compiled = core.compileProfile(profile);
  assert.equal(compiled.rules.length, 2);
  assert.deepEqual(compiled.rules[0].condition.resourceTypes, ['script', 'xmlhttprequest']);
  assert.equal(compiled.rules[0].condition.regexFilter, '^https://one\\.');
  assert.equal(compiled.rules[1].condition.regexFilter, '^https:\\/\\/two\\.example\\/.*$');
  assert.deepEqual(compiled.rules[0].action.requestHeaders, [
    { header: 'X-Test', operation: 'set', value: 'one' }
  ]);
  assert.deepEqual(compiled.rules[0].action.responseHeaders, [
    { header: 'Server', operation: 'set', value: '' }
  ]);
  assert.equal(JSON.stringify(compiled.rules).includes('not emitted'), false);
});

test('a resource filter with no selected types intentionally matches nothing', () => {
  const profile = core.createProfile();
  profile.requestHeaders = [
    { id: 'h', enabled: true, name: 'X-Test', value: 'one', comment: '' }
  ];
  profile.filters = [{ id: 'r', enabled: true, kind: 'resource', resourceTypes: [] }];
  assert.deepEqual(core.compileProfile(profile).rules, []);
});

test('disabled and blank filters do not restrict requests', () => {
  const profile = core.createProfile();
  profile.requestHeaders = [
    { id: 'h', enabled: true, name: 'X-Test', value: 'one', comment: '' }
  ];
  profile.filters = [
    { id: 'a', enabled: false, kind: 'url', patternType: 'regex', pattern: '[' },
    { id: 'b', enabled: true, kind: 'url', patternType: 'regex', pattern: '   ' }
  ];
  const compiled = core.compileProfile(profile);
  assert.equal(compiled.rules.length, 1);
  assert.deepEqual(compiled.rules[0].condition, { resourceTypes: core.RESOURCE_TYPES });
  assert.deepEqual(compiled.regexes, []);
});

test('the profile filter master switch bypasses all filter conditions', () => {
  const profile = core.createProfile();
  profile.requestHeaders = [
    { id: 'h', enabled: true, name: 'X-Test', value: 'one', comment: '' }
  ];
  profile.filtersEnabled = false;
  profile.filters = [
    { id: 'invalid', enabled: true, kind: 'url', patternType: 'regex', pattern: '[' },
    { id: 'empty-resource', enabled: true, kind: 'resource', resourceTypes: [] }
  ];
  const compiled = core.compileProfile(profile);
  assert.equal(compiled.rules.length, 1);
  assert.deepEqual(compiled.rules[0].condition, { resourceTypes: core.RESOURCE_TYPES });
  assert.deepEqual(compiled.regexes, []);
});

test('normalization preserves an off filter master switch and defaults legacy profiles on', () => {
  const off = core.normalizeState({
    profiles: [{ title: 'Off', filtersEnabled: false, headers: [] }]
  });
  const legacy = core.normalizeState({ profiles: [{ title: 'Legacy', headers: [] }] });
  assert.equal(off.profiles[0].filtersEnabled, false);
  assert.equal(legacy.profiles[0].filtersEnabled, true);
});

test('last enabled duplicate header wins deterministically', () => {
  const profile = core.createProfile();
  profile.requestHeaders = [
    { enabled: true, name: 'X-Test', value: 'first' },
    { enabled: true, name: 'x-test', value: 'second' }
  ];
  const action = core.compileProfile(profile).rules[0].action.requestHeaders;
  assert.deepEqual(action, [{ header: 'x-test', operation: 'set', value: 'second' }]);
});

test('invalid header names fail before Chrome rule installation', () => {
  const profile = core.createProfile();
  profile.requestHeaders = [
    { id: 'h', enabled: true, name: 'Bad Header', value: 'one', comment: '' }
  ];
  assert.throws(() => core.compileProfile(profile), /Invalid request header name/);
});

test('normalization caps oversized collections', () => {
  const profiles = Array.from({ length: 80 }, (_, index) => ({
    title: `P${index}`,
    headers: Array.from({ length: 250 }, () => ({ name: 'X-Test', value: 'v' })),
    filters: Array.from({ length: 140 }, () => ({ type: 'urls', urlRegex: '.*' }))
  }));
  const state = core.normalizeState({ profiles });
  assert.equal(state.profiles.length, 50);
  assert.equal(state.profiles[0].requestHeaders.length, 200);
  assert.equal(state.profiles[0].filters.length, 100);
});

test('exported backups round-trip through normalization', () => {
  const original = core.createDefaultState();
  original.profiles[0].requestHeaders = [
    { id: 'h', enabled: true, name: 'X-Round-Trip', value: 'one', comment: '' }
  ];
  const restored = core.normalizeState(JSON.stringify(core.exportBackup(original)));
  assert.equal(restored.profiles[0].requestHeaders[0].name, 'X-Round-Trip');
});
