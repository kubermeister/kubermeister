/**
 * What makes a route's screen a different screen. TanStack Router keys a match by route id alone,
 * so moving from one object to another of the same kind (a deep link, Back, the palette) would hand
 * the new object the old one's local state: a revealed Secret value, an edited manifest, a drain in
 * progress. Every path parameter names the object, except the tab, which is how a `keepMounted`
 * panel survives a switch to another tab of the same object.
 */
export function objectRemountDeps({ params }: { params: object }): Record<string, unknown> {
    const { tab: _tab, ...identity } = params as Record<string, unknown>;
    return identity;
}
