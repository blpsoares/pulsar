import cliprogress from 'cli-progress';

export const createSingleBar = (start: number, progressMessage: string = 'Progress') => {
  const singleBar = new cliprogress.SingleBar({
    format: `⟬{bar}⟭ {percentage}% | {duration_formatted} | {value}/{total} | ${progressMessage}`,
    barCompleteChar: '※',
    barIncompleteChar: '⁍',
    emptyOnZero: true,
  });

  singleBar.start(start, 0);

  return singleBar;
};
