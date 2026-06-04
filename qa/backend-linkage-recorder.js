/*
  CoGo City Backend Linkage Recorder

  Use on https://staging.cogocity.com while manually testing buttons.
  Paste this whole file into the browser DevTools Console, then click buttons.

  Helpful commands:
    window.CoGoQaRecorder.start('admin suspend user');
    window.CoGoQaRecorder.summary();
    window.CoGoQaRecorder.clear();
    window.CoGoQaRecorder.stop();
*/
(function installCoGoQaRecorder(){
  if (window.CoGoQaRecorder && window.CoGoQaRecorder.installed) {
    console.warn('CoGo QA recorder is already installed.');
    return;
  }

  const originalFetch = window.fetch.bind(window);
  const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
  const originalRemoveItem = window.localStorage.removeItem.bind(window.localStorage);
  const originalClear = window.localStorage.clear.bind(window.localStorage);
  const state = {
    installed: true,
    enabled: true,
    section: 'manual qa',
    events: [],
    startedAt: new Date().toISOString()
  };

  function now(){
    return new Date().toISOString();
  }

  function shortBody(body){
    if (!body) return '';
    try {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    } catch (error) {
      return '[unreadable body]';
    }
  }

  function requestUrl(input){
    if (typeof input === 'string') return input;
    if (input && input.url) return input.url;
    return String(input || '');
  }

  function requestMethod(input, init){
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function isApiUrl(url){
    return /(^|\/)api\//.test(String(url || '')) || String(url || '').startsWith('/api');
  }

  function addEvent(event){
    if (!state.enabled) return;
    state.events.push(Object.assign({ at: now(), section: state.section }, event));
  }

  window.fetch = async function recordedFetch(input, init){
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const api = isApiUrl(url);
    const started = performance.now();
    if (api) {
      addEvent({
        type: 'backend-request',
        method,
        url,
        body: shortBody(init && init.body)
      });
    }
    try {
      const response = await originalFetch(input, init);
      if (api) {
        addEvent({
          type: 'backend-response',
          method,
          url,
          status: response.status,
          ok: response.ok,
          ms: Math.round(performance.now() - started)
        });
      }
      return response;
    } catch (error) {
      if (api) {
        addEvent({
          type: 'backend-error',
          method,
          url,
          message: error && error.message ? error.message : String(error),
          ms: Math.round(performance.now() - started)
        });
      }
      throw error;
    }
  };

  window.localStorage.setItem = function recordedSetItem(key, value){
    addEvent({
      type: 'local-storage-write',
      key: String(key),
      valuePreview: String(value || '').slice(0, 160)
    });
    return originalSetItem(key, value);
  };

  window.localStorage.removeItem = function recordedRemoveItem(key){
    addEvent({
      type: 'local-storage-remove',
      key: String(key)
    });
    return originalRemoveItem(key);
  };

  window.localStorage.clear = function recordedClear(){
    addEvent({ type: 'local-storage-clear' });
    return originalClear();
  };

  function summarize(){
    const backendRequests = state.events.filter(event => event.type === 'backend-request');
    const backendResponses = state.events.filter(event => event.type === 'backend-response');
    const backendErrors = state.events.filter(event => event.type === 'backend-error');
    const localWrites = state.events.filter(event => event.type.startsWith('local-storage'));
    const failedResponses = backendResponses.filter(event => !event.ok);
    const verdict = backendRequests.length && !backendErrors.length && !failedResponses.length
      ? 'backend-backed signal found'
      : (backendRequests.length ? 'backend call found, but check failed/error responses' : 'no backend API call recorded');

    const summary = {
      section: state.section,
      startedAt: state.startedAt,
      checkedAt: now(),
      verdict,
      backendRequestCount: backendRequests.length,
      backendErrorCount: backendErrors.length,
      failedBackendResponseCount: failedResponses.length,
      localStorageEventCount: localWrites.length,
      backendRequests: backendRequests.map(event => ({
        method: event.method,
        url: event.url,
        at: event.at
      })),
      failedBackendResponses: failedResponses.map(event => ({
        method: event.method,
        url: event.url,
        status: event.status,
        at: event.at
      })),
      backendErrors,
      localStorageKeysTouched: Array.from(new Set(localWrites.map(event => event.key).filter(Boolean))).sort()
    };

    console.table(summary.backendRequests);
    if (summary.failedBackendResponses.length) console.table(summary.failedBackendResponses);
    if (summary.backendErrors.length) console.table(summary.backendErrors);
    if (summary.localStorageKeysTouched.length) console.log('Local storage keys touched:', summary.localStorageKeysTouched);
    console.log('CoGo QA summary:', summary);
    return summary;
  }

  window.CoGoQaRecorder = {
    installed: true,
    start(section){
      state.enabled = true;
      state.section = section || 'manual qa';
      state.events = [];
      state.startedAt = now();
      console.log(`CoGo QA recording started: ${state.section}`);
    },
    stop(){
      state.enabled = false;
      console.log('CoGo QA recording stopped.');
    },
    clear(){
      state.events = [];
      state.startedAt = now();
      console.log('CoGo QA recording cleared.');
    },
    events(){
      return state.events.slice();
    },
    summary: summarize,
    restore(){
      window.fetch = originalFetch;
      window.localStorage.setItem = originalSetItem;
      window.localStorage.removeItem = originalRemoveItem;
      window.localStorage.clear = originalClear;
      state.enabled = false;
      console.log('CoGo QA recorder removed.');
    }
  };

  console.log('CoGo QA recorder installed. Run window.CoGoQaRecorder.start("what you are testing"), click a button, then run window.CoGoQaRecorder.summary().');
})();
