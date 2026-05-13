(function () {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;

  let nextRendererId = 0;
  const renderers = new Map();
  const fiberRoots = new Map();

  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject(renderer) {
      const rendererId = ++nextRendererId;
      renderers.set(rendererId, renderer);
      fiberRoots.set(rendererId, new Set());
      return rendererId;
    },
    onCommitFiberRoot(rendererId, root) {
      let roots = fiberRoots.get(rendererId);
      if (!roots) {
        roots = new Set();
        fiberRoots.set(rendererId, roots);
      }
      const current = root?.current;
      const isUnmounting =
        current?.memoizedState == null ||
        current?.memoizedState?.element == null;
      if (isUnmounting) {
        roots.delete(root);
        return;
      }
      roots.add(root);
    },
    onCommitFiberUnmount() {},
    getFiberRoots(rendererId) {
      return fiberRoots.get(rendererId) || new Set();
    },
    sub() {
      return function unsubscribe() {};
    },
    checkDCE() {},
  };
})();
