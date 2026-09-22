import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StartupGate } from '@/components/startup-gate';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { subscribe } from '@/lib/ipc';
import { queryClient } from '@/lib/query';
import { router } from '@/lib/router';

export function App() {
    // The application menu's Settings item pushes this from the main process.
    useEffect(() => subscribe('open-settings', () => void router.navigate({ to: '/settings' })), []);
    return (
        <ThemeProvider defaultTheme="dark" storageKey="km-theme">
            <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={300}>
                    <StartupGate>
                        <RouterProvider router={router} />
                    </StartupGate>
                    <Toaster position="bottom-right" />
                </TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>
    );
}
