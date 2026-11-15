importScripts('solver.js?v=20261115-2');
self.onmessage = ({ data }) => {
  const iterator = TourSolver.solve(data);
  let next;
  let last = 0;
  while (!(next = iterator.next()).done) {
    if (Date.now() - last > 200) { self.postMessage({ type: 'progress', data: next.value }); last = Date.now(); }
  }
  self.postMessage({ type: 'result', data: next.value });
};
