import figlet from 'figlet';
import chalk from 'chalk';

export const showTitle = () => {
  return new Promise((resolve) => {
    figlet('_| PULSAR |_', { font: 'Big', verticalLayout: 'controlled smushing' }, (err, title) => {
      if (err) {
        console.log('«« PULSAR »»');
      } else {
        console.log(chalk.hex('#9b00ff').bold(title).concat(`\n\n`));
      }
      resolve(true);
    });
  });
};
