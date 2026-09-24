import type { ReleaseObject } from '../../shared/k8s/addons';
import { KIND_STATUS_TONE, RELEASE_OBJECT_TONE, type StatusTone } from './status';

/**
 * A release's health as its objects have it, rather than as Helm recorded it: `deployed` only says
 * the install went through, not that what it installed is still there and running.
 */
export type ReleaseHealth = 'Healthy' | 'Degraded' | 'Failing' | 'Unknown';

export interface ObjectBadge {
    label: string;
    tone: StatusTone;
}

/**
 * What an object's badge says: its kind's own status word when it has one, coloured by that kind's
 * own tone map, and otherwise only whether it is there.
 */
export function objectBadge(object: ReleaseObject): ObjectBadge {
    if (object.state !== 'Present') return { label: object.state, tone: RELEASE_OBJECT_TONE[object.state] };
    if (object.status) {
        const tone = KIND_STATUS_TONE[object.status.kind][object.status.value] ?? 'neutral';
        return { label: object.status.value, tone };
    }
    return { label: 'Present', tone: RELEASE_OBJECT_TONE.Present };
}

export interface ReleaseRollup {
    health: ReleaseHealth;
    /** One sentence, naming the object that decided the health when one did. */
    reason: string;
    /** The object the reason names: the first one, in manifest order, at the worst tone. */
    worst?: ReleaseObject;
}

/** Only these tones make a release unhealthy; neutral and accent are states, not problems. */
const SEVERITY: Partial<Record<StatusTone, number>> = { danger: 2, warn: 1 };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The release's health from its objects. The worst object is the reason, so a broken release says
 * which object broke it instead of leaving the reader to scan the table for the red row.
 */
export function rollUp(objects: readonly ReleaseObject[]): ReleaseRollup {
    if (objects.length === 0) {
        return { health: 'Unknown', reason: 'The current revision rendered no objects to check.' };
    }
    let worst: { object: ReleaseObject; badge: ObjectBadge; severity: number } | undefined;
    let troubled = 0;
    for (const object of objects) {
        const badge = objectBadge(object);
        const severity = SEVERITY[badge.tone] ?? 0;
        if (severity === 0) continue;
        troubled += 1;
        if (!worst || severity > worst.severity) worst = { object, badge, severity };
    }
    if (worst) {
        const others = troubled - 1;
        const tail =
            others > 0 ? `, and ${plural(others, 'other object')} ${others === 1 ? 'needs' : 'need'} attention` : '';
        return {
            health: worst.severity === 2 ? 'Failing' : 'Degraded',
            reason: `${worst.object.kind} ${worst.object.name} is ${worst.badge.label}${tail}.`,
            worst: worst.object,
        };
    }
    const unknown = objects.filter((object) => object.state === 'Unknown');
    if (unknown.length > 0) {
        return {
            health: 'Unknown',
            reason: `${plural(unknown.length, 'object')} could not be read: ${unknown[0]!.note ?? 'no reason given.'}`,
            worst: unknown[0],
        };
    }
    const reason =
        objects.length === 1
            ? 'Its one object is present and healthy.'
            : `All ${objects.length} objects are present and healthy.`;
    return { health: 'Healthy', reason };
}
