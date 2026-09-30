import { useState } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import { bugReportUrl } from '../../../shared/bug-report';
import { releasePageUrl } from '../../../shared/updates';
import { FormCard } from '@/components/templates/settings-form';
import { Button } from '@/components/ui/button';
import { useIpcQuery } from '@/lib/query';
import { describeUpdate, downloadUpdate, installUpdate, useUpdater } from '@/lib/updates';

/** This install's version and the updater's outcome, with the check the user can start. */
export function AboutCard() {
    const info = useIpcQuery('app.info', {});
    const { state, check } = useUpdater();
    const [checking, setChecking] = useState(false);
    const { title, detail } = describeUpdate(state);

    const runCheck = async () => {
        setChecking(true);
        try {
            await check();
        } finally {
            setChecking(false);
        }
    };

    return (
        <FormCard
            title="About"
            desc="This install and its update status."
            action={
                <Button
                    variant="outline"
                    size="sm"
                    disabled={checking || state?.status === 'unsupported'}
                    onClick={() => void runCheck()}
                >
                    Check for updates
                </Button>
            }
        >
            <div className="flex flex-col gap-2" data-testid="about-card">
                <div className="flex items-center gap-2 text-lead font-medium">
                    <span>{info.data?.name ?? 'Kubermeister'}</span>
                    <span className="font-mono text-body text-text-2">{info.data?.version ?? '—'}</span>
                </div>
                {info.data && (
                    <div className="text-meta text-text-muted">
                        Electron {info.data.electron} · Chrome {info.data.chrome} · Node {info.data.node}
                    </div>
                )}
                <div className="mt-1 flex flex-col gap-1 text-cell" data-testid="update-status">
                    <span>{title}</span>
                    {detail && <span className="whitespace-pre-wrap text-text-muted">{detail}</span>}
                </div>
                <div className="flex items-center gap-2 empty:hidden">
                    {state?.status === 'available' && (
                        <Button size="sm" onClick={() => void downloadUpdate()}>
                            Download update
                        </Button>
                    )}
                    {state?.status === 'downloaded' && (
                        <Button size="sm" onClick={() => void installUpdate()}>
                            Restart now
                        </Button>
                    )}
                    {/* The changelog is not in the app at all, so every card naming a version links to it. */}
                    {state?.version && state.status !== 'error' && (
                        // A package the system owns is fetched from the release page by hand, so for
                        // that state the link is the action rather than a footnote beside one.
                        <Button size="sm" variant={state.status === 'manual' ? 'default' : 'ghost'} asChild>
                            <a href={releasePageUrl(state.version)} target="_blank" rel="noreferrer">
                                {state.status === 'manual' ? 'Get the update' : <>What&apos;s new</>}
                                <ExternalLinkIcon />
                            </a>
                        </Button>
                    )}
                    {/* The version and the platform are on this very card, so the form arrives with
                        them filled in rather than asking the reporter to copy them across. */}
                    {info.data && (
                        <Button size="sm" variant="ghost" asChild>
                            <a href={bugReportUrl(info.data)} target="_blank" rel="noreferrer">
                                Report a bug
                                <ExternalLinkIcon />
                            </a>
                        </Button>
                    )}
                </div>
            </div>
        </FormCard>
    );
}
