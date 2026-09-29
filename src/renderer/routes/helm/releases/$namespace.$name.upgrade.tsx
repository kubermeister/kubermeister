import { createFileRoute } from '@tanstack/react-router';
import { UpgradeRelease } from '@/components/release/upgrade-release';

/**
 * Where upgrading one release starts, beside its detail rather than inside it: the upgrade is a
 * screen of its own, with a review between the values and the write, and ends back on the release.
 */
export const Route = createFileRoute('/helm/releases/$namespace/$name/upgrade')({ component: UpgradeReleasePage });

function UpgradeReleasePage() {
    const { namespace, name } = Route.useParams();
    // A new release is a new form; nothing typed for one is meant for another.
    return <UpgradeRelease key={`${namespace}/${name}`} namespace={namespace} name={name} />;
}
