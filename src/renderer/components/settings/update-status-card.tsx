import { useState } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import { releasePageUrl } from '../../../shared/updates';
import { FormCard } from '@/components/templates/settings-form';
import { Button } from '@/components/ui/button';
import { describeUpdate, downloadUpdate, installUpdate, useUpdater } from '@/lib/updates';

/** The updater's outcome, with the check the user can start and whatever that outcome offers next. */
export function UpdateStatusCard() {
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
            title="Update status"
            desc="What the last check for a new version found."
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
            <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1 text-cell" data-testid="update-status">
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
                </div>
            </div>
        </FormCard>
    );
}
