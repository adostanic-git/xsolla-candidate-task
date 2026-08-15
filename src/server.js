const app = require('./app');
const config = require('./config');

app.listen(config.PORT, () => {
  console.log(`ai-diff-review-service listening on port ${config.PORT}`);
});
