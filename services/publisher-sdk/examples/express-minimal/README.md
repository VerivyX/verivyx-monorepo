# express-minimal

Minimal Express app showing Verivyx paywall integration.

## Install

```
npm i @verivyx/paywall-express
```

## Usage

```ts
import express from "express";
import { verivyxExpress } from "@verivyx/paywall-express";

const vx = verivyxExpress();
const app = express();
app.get("/articles/:slug", vx.protect((req, res) =>
  res.json({ body: `full article ${req.params.slug}` })
));
app.listen(3000);
```

## Run live

Set `VERIVYX_TOKEN` before starting (token-only config):

```
VERIVYX_TOKEN=<your-token> node src/server.js
```

`VERIVYX_DOMAIN` is optional (a legacy analytics label) and not required.
