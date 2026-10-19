// task-1319 (AC1) test stub: make every live request hang until its AbortSignal fires, standing in for
// a hung/slow endpoint. Loaded with `node --import` so it replaces globalThis.fetch before the app's
// liveTransport reads it. Each pending fetch holds a ref'd timer (a bare pending promise would NOT keep
// the event loop alive) to mimic the live socket handle that lingers until a request settles. On abort
// the handle is cleared and the promise rejects at once. This proves the shipped app's feed.close()
// actually aborts in-flight fetches: without the shutdown wiring the createLiveFeed transport has no
// signal, so quit lingers until liveTransport's own ~10 s timeout fires; with it, quit exits sub-second.
globalThis.fetch = (url, init = {}) => {
  const signal = init && init.signal;
  return new Promise((_resolve, reject) => {
    const handle = setTimeout(() => {}, 1 << 30); // ref'd: stands in for the in-flight socket handle.
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal && signal.reason ? signal.reason : new DOMException('aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
};
