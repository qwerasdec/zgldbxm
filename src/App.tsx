import { Route, Routes } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import AuthPage from './pages/AuthPage'
import HistoryPage from './pages/HistoryPage'
import JoinPage from './pages/JoinPage'
import LobbyPage from './pages/LobbyPage'
import MeetingPage from './pages/MeetingPage'
import SchedulePage from './pages/SchedulePage'

function App() {
  return (
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/schedule" element={<SchedulePage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/join" element={<ProtectedRoute><JoinPage /></ProtectedRoute>} />
      <Route path="/meeting" element={<ProtectedRoute><MeetingPage /></ProtectedRoute>} />
    </Routes>
  )
}

export default App
