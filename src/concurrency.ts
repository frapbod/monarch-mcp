export async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  limit: number,
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index] as Input, index);
      }
    }),
  );
  return results;
}
