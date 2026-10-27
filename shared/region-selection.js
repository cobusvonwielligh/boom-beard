export function closestReachable(results) {
  return results
    .filter(result => result.online === true && Number.isFinite(result.rttMs))
    .sort((a, b) => a.rttMs - b.rttMs || a.id.localeCompare(b.id))[0]?.id ?? null;
}

export function selectedRegionId(results, manualId = null) {
  if (manualId !== null) {
    return results.some(result => result.id === manualId && result.online) ? manualId : null;
  }
  return closestReachable(results);
}
