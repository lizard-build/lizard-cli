const http = require("http");
const port = process.env.PORT || 3000;
http.createServer((_, res) => {
  res.end("hello from lizard test\n");
}).listen(port);
