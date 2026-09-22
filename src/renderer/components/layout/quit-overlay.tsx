import { useEffect, useState } from 'react';
import { invoke, subscribe } from '@/lib/ipc';
import { cn } from '@/lib/utils';

/**
 * The hint shown while `Cmd+Q` is held on macOS, where a tap alone no longer quits. Main does the
 * timing and the quitting; this only draws what it pushes, and tells main it is here — without
 * that, a keystroke would be swallowed for a second by a hint nobody can see, so a renderer that
 * never mounted leaves the shortcut quitting as it always did.
 *
 * It sits where a toast does, outside the startup gate, since the hint belongs to the window
 * rather than to any screen. The element stays mounted so leaving has something to fade.
 */
export function QuitOverlay() {
    const [holding, setHolding] = useState(false);

    useEffect(() => {
        const unsubscribe = subscribe('quit.hold', (state) => setHolding(state.holding));
        void invoke('quit.overlayReady', { ready: true });
        return () => {
            unsubscribe();
            void invoke('quit.overlayReady', { ready: false });
        };
    }, []);

    return (
        <div
            role="status"
            aria-hidden={!holding}
            data-testid="quit-hold"
            className={cn(
                'pointer-events-none fixed right-4 bottom-4 z-50 rounded-card border border-border bg-elev-2 px-4 py-2.5 text-body shadow-lg transition-opacity duration-200',
                holding ? 'opacity-100' : 'opacity-0',
            )}
        >
            Hold <span className="font-mono text-text-2">⌘Q</span> to Quit
        </div>
    );
}
