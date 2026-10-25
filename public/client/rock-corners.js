export function rockCornerRadii(up, right, down, left, radius) {
  return [
    up || left ? 0 : radius,
    up || right ? 0 : radius,
    down || right ? 0 : radius,
    down || left ? 0 : radius,
  ];
}
