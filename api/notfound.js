module.exports = async (_req, res) => {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ detail: "Not Found" }));
};

