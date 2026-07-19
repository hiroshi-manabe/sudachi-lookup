import handler from "vinext/server/app-router-entry";

type HandlerFetch = typeof handler.fetch;

const worker = {
  fetch(
    request: Request,
    env: Parameters<HandlerFetch>[1],
    context: Parameters<HandlerFetch>[2],
  ) {
    return handler.fetch(request, env, context);
  },
};

export default worker;
