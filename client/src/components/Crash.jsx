import { Component } from 'react';
import { reportError } from '../lib/report';

/**
 * What somebody sees when the app itself throws. Before this there was nothing: React
 * unmounted the tree and left a white screen, with no message, no way back, and no sign
 * anywhere that it had happened. A blank page is how you lose a person for good.
 *
 * A class, because catching a render error is the one thing hooks cannot do.
 */
export default class Crash extends Component {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    reportError(error?.message || 'Render error', `${error?.stack || ''}\n${info?.componentStack || ''}`);
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-5 px-8 pb-safe pt-safe text-center">
        <span className="grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-bad/30 to-bad/5 text-3xl text-bad">!</span>
        <div>
          <p className="text-lg font-light">Something went wrong</p>
          <p className="mt-1 max-w-xs text-sm text-mute">
            Jarvis has been told what happened. Nothing you sent is lost — reloading usually fixes it.
          </p>
        </div>
        <button onClick={() => window.location.reload()}
          className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2.5 font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">
          Reload Jarvis
        </button>
      </div>
    );
  }
}
