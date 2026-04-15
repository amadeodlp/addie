const fs = require('fs');
const files = ['themes.js', 'i18n.js', 'app.js', 'onboarding.js'];
for (const f of files) {
  const code = fs.readFileSync('D:/projects/addie/ui/' + f, 'utf8');
  try {
    new Function(code);
    console.log(f + ': OK');
  } catch(e) {
    console.log(f + ': ERROR - ' + e.message);
  }
}
