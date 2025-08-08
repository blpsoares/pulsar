import figlet from 'figlet';
import chalk from 'chalk';

export const showTitle = () => {
  return new Promise((resolve) => {
    figlet('P U L S A R', { font: 'Rectangles', verticalLayout: 'controlled smushing' }, (err, title) => {
      if (err) {
        console.log('«« PULSAR »»');
      } else {
        console.log(chalk.italic.hex('#9b00ff').bold(title).concat(`\n\n`));
      }
      resolve(true);
    });
  });
};