import { LinkIcon } from 'lucide-react';
import { DetailCard } from '@/components/templates/detail-cards';
import { NavLink } from '@/components/layout/nav-link';
import { ReadFailure } from '@/components/templates/read-failure';
import { useIpcQuery } from '@/lib/query';
import type { ManifestKind } from '../../../shared/k8s/manifest';
import type { DetailTab } from './resource-detail';

/**
 * The Related tab: what else this object is tied to, each link saying why. A relation the app
 * cannot explain is not shown, so everything here comes from the object's own spec or from a
 * selector that actually covers its labels.
 */
export function relatedTab(target: { kind: ManifestKind; name: string; namespace?: string }): DetailTab {
    return {
        id: 'related',
        label: 'Related',
        icon: LinkIcon,
        content: <RelatedPanel {...target} />,
    };
}

function RelatedPanel({ kind, name, namespace }: { kind: ManifestKind; name: string; namespace?: string }) {
    const query = useIpcQuery('resources.related', { kind, name, namespace });
    if (query.isPending) {
        return (
            <DetailCard title="Related">
                <p className="text-body text-text-muted" data-testid="related-pending">
                    Reading what this object is tied to…
                </p>
            </DetailCard>
        );
    }
    if (query.isError) {
        return (
            <DetailCard title="Related">
                <ReadFailure error={query.error} subject={{ one: kind }} onRetry={() => void query.refetch()} />
            </DetailCard>
        );
    }
    const groups = query.data;
    if (groups.length === 0) {
        return (
            <DetailCard title="Related">
                <p className="text-body text-text-muted" data-testid="related-empty">
                    Nothing else names this object.
                </p>
            </DetailCard>
        );
    }
    return (
        <>
            {groups.map((group) => (
                <DetailCard key={group.label} title={group.label}>
                    <div className="flex flex-col gap-1.5" data-testid={`related-${group.label.toLowerCase()}`}>
                        {group.items.map((item) => (
                            <div
                                key={`${item.kind}/${item.name}/${item.why}`}
                                className="flex items-baseline justify-between gap-4 text-body"
                                data-related={item.name}
                            >
                                <span className="truncate">
                                    <span className="text-meta text-text-muted">{item.kind}</span>{' '}
                                    {item.path ? (
                                        <NavLink to={item.path} className="font-mono text-primary hover:underline">
                                            {item.name}
                                        </NavLink>
                                    ) : (
                                        <span className="font-mono text-text-2">{item.name}</span>
                                    )}
                                </span>
                                <span className="shrink-0 text-meta text-text-muted">{item.why}</span>
                            </div>
                        ))}
                    </div>
                </DetailCard>
            ))}
        </>
    );
}
