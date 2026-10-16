import { EthProvider } from "./contexts/EthContext";
import MainComp from "./Main";

function App() {
  return (
    <EthProvider>
      <div id="App">
        <div className="container">
          <MainComp/>
        </div>
      </div>
    </EthProvider>
  );
}

export default App;