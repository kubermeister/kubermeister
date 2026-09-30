import { ExternalLinkIcon } from 'lucide-react';
import { bugReportUrl } from '../../../shared/bug-report';
import { FormCard } from '@/components/templates/settings-form';
import { Button } from '@/components/ui/button';
import { useIpcQuery } from '@/lib/query';

/** This install's version and what it runs on, with the bug report that carries both. */
export function AboutCard() {
    const info = useIpcQuery('app.info', {});

    return (
        <FormCard title="About" desc="This install and what it runs on.">
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
                {/* The version and the platform are on this very card, so the form arrives with
                    them filled in rather than asking the reporter to copy them across. */}
                {info.data && (
                    <div>
                        <Button size="sm" variant="ghost" asChild>
                            <a href={bugReportUrl(info.data)} target="_blank" rel="noreferrer">
                                Report a bug
                                <ExternalLinkIcon />
                            </a>
                        </Button>
                    </div>
                )}
            </div>
        </FormCard>
    );
}
