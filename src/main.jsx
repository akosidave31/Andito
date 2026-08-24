import "./storagePolyfill.js";
import React from "react";
import ReactDOM from "react-dom/client";
import Andito from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Andito />
  </React.StrictMode>
);
