// One-dimensional lower-envelope pass for squared Euclidean distance.
function transformLine(values, length, output, sites, boundaries) {
  let last = -1;
  for (let q = 0; q < length; q++) {
    if (!Number.isFinite(values[q])) continue;
    let intersection = -Infinity;
    while (last >= 0) {
      const p = sites[last];
      intersection = ((values[q] + q * q) - (values[p] + p * p)) / (2 * (q - p));
      if (intersection > boundaries[last]) break;
      last--;
    }
    last++;
    sites[last] = q;
    boundaries[last] = last === 0 ? -Infinity : intersection;
    boundaries[last + 1] = Infinity;
  }

  if (last < 0) {
    output.fill(Infinity, 0, length);
    return;
  }

  let site = 0;
  for (let q = 0; q < length; q++) {
    while (site < last && boundaries[site + 1] < q) site++;
    const delta = q - sites[site];
    output[q] = delta * delta + values[sites[site]];
  }
}

// Exact squared distance from each grid cell to the nearest nonzero mask cell.
export function squaredDistanceToLand(width, height, landMask) {
  const vertical = new Float64Array(width * height);
  const distances = new Float64Array(width * height);
  const capacity = Math.max(width, height);
  const input = new Float64Array(capacity);
  const output = new Float64Array(capacity);
  const sites = new Int32Array(capacity);
  const boundaries = new Float64Array(capacity + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      input[y] = landMask[y * width + x] ? 0 : Infinity;
    }
    transformLine(input, height, output, sites, boundaries);
    for (let y = 0; y < height; y++) vertical[y * width + x] = output[y];
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) input[x] = vertical[row + x];
    transformLine(input, width, output, sites, boundaries);
    for (let x = 0; x < width; x++) distances[row + x] = output[x];
  }

  return distances;
}
