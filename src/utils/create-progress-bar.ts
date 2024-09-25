import cliprogress from 'cli-progress';

export const createSingleBar = (start: number) => {
  const singleBar = new cliprogress.SingleBar({
    format: 'Export progress | {bar} | {percentage}% | {duration_formatted} | {value}/{total}',
    barCompleteChar: '※',
    barIncompleteChar: '⁍',
  });

  singleBar.start(start, 0);

  return singleBar;
};
