export async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  limit: number,
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length && !failed) {
        const index = next++;
        try {
          results[index] = await operation(values[index] as Input, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
