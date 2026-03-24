import { Hono } from "@hono/hono";
import { siteStatusRoute } from "./site.tsx";
import { statusRoute } from "./status.tsx";

const statusRouter = new Hono();

statusRouter.on(["GET", "HEAD"], "/", (c) => statusRoute(c));
statusRouter.on(["GET", "HEAD"], "/:address", (c) => siteStatusRoute(c));

export default statusRouter;
