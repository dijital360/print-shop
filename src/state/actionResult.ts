/** Run UI feedback only after the store confirms the change. */
export function afterAction(
  result: boolean | Promise<boolean>,
  onSuccess: () => void,
  onFailure?: () => void,
): void {
  const settled = (ok: boolean): void => {
    if (ok) onSuccess();
    else onFailure?.();
  };
  if (typeof result === "boolean") settled(result);
  else void result.then(settled, () => onFailure?.());
}
