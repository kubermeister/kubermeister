import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ChevronDownIcon, TerminalIcon } from 'lucide-react';
import type { PodDetail } from '../../../shared/k8s/pods';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContainerRoleNote } from '@/components/pod/container-role-note';
import type { StreamHandle } from '@/lib/ipc';
import { containerChoices } from '@/lib/pod-containers';
import { openPodExec } from '@/lib/pod-streams';
import { useTerminalFontSize } from '@/lib/settings';
import { readTerminalLook, readTerminalTheme } from '@/lib/terminal-look';

/**
 * The pod's Shell tab: an exec session into one of its containers, running in the tab itself. A
 * shell belongs to the pod it is a shell into, so it opens when this tab does and ends with it.
 * The tab is not kept mounted on purpose: merely looking at a pod should never exec into it.
 */
export function ShellTab({ name, namespace, pod }: { name: string; namespace: string; pod?: PodDetail | null }) {
    const ref = useRef<HTMLDivElement>(null);
    // A shell needs a running process to attach to, which a finished init container no longer has.
    const choices = containerChoices(pod?.containers, ['app', 'ephemeral']);
    const containers = choices.map((c) => c.name);
    const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
    const container = selectedContainer && containers.includes(selectedContainer) ? selectedContainer : containers[0];
    const fontSize = useTerminalFontSize();

    useEffect(() => {
        const host = ref.current;
        // Wait until the pod (and so a container) has resolved, or one session would open against a
        // default first and a second against the right container a moment later.
        if (!host || !container) return;
        const look = readTerminalLook(document.documentElement, fontSize);
        const term = new Terminal({
            fontFamily: look.fontFamily,
            fontSize: look.fontSize,
            cursorBlink: true,
            theme: look.theme,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);
        // Fit after layout settles, so xterm sizes to the panel's real height, and only then open the
        // session: the size it opens with is the size the shell starts at, and a resize sent while
        // the session is still starting has nowhere to go yet.
        let control: StreamHandle | null = null;
        const raf = requestAnimationFrame(() => {
            fit.fit();
            control = openPodExec(
                { name, namespace, container, size: { cols: term.cols, rows: term.rows } },
                {
                    onData: (chunk) => term.write(chunk),
                    onError: (message) => term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`),
                    onEnd: () => term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'),
                },
            );
        });
        const typed = term.onData((data) => control?.send(data));
        // Every later fit that changes the grid is passed on to the shell, which otherwise lays out
        // `top`, `vi` and a wrapping prompt for the size it started at.
        const resized = term.onResize(({ cols, rows }) => control?.send({ resize: { cols, rows } }));
        // Re-fit when the panel resizes (tab layout, window), not only on a window resize.
        const resize = new ResizeObserver(() => fit.fit());
        resize.observe(host);
        // Re-read the theme tokens when the app flips light or dark, without restarting the session.
        const theme = new MutationObserver(() => {
            term.options.theme = readTerminalTheme(host);
        });
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        return () => {
            cancelAnimationFrame(raf);
            resize.disconnect();
            theme.disconnect();
            typed.dispose();
            resized.dispose();
            control?.stop();
            term.dispose();
        };
        // The font size is read when the session opens; changing it must not restart the shell.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [name, namespace, container]);

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="shell-tab">
            <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-card bg-code-bg py-0 shadow-none">
                <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
                    <TerminalIcon className="size-3.5 text-text-muted" />
                    <span className="text-meta text-text-2">{name}</span>
                    {containers.length > 0 && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="xs"
                                    disabled={containers.length < 2}
                                    aria-label="Container"
                                >
                                    {container ?? '—'}
                                    <ChevronDownIcon />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {choices.map((one) => (
                                    <DropdownMenuItem key={one.name} onSelect={() => setSelectedContainer(one.name)}>
                                        {one.name}
                                        <ContainerRoleNote role={one.role} />
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    <span className="text-meta text-text-muted">/bin/sh</span>
                </div>
                <div ref={ref} className="min-h-0 flex-1 overflow-hidden p-2" data-testid="terminal-host" />
            </Card>
        </div>
    );
}
