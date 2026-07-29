(function () {
  const target = globalThis.window ?? globalThis;
  const ui = target.SessionDeckUI;
  const hostFactory = target.SessionDeckIterm2Host;
  const document = globalThis.document;

  if (typeof ui?.mount !== 'function' || typeof hostFactory?.createHost !== 'function') {
    throw new Error('Session Deck web UI failed to initialize.');
  }

  ui.mount({
    document,
    window: target,
    host: hostFactory.createHost({ document, window: target }),
  });
})();
