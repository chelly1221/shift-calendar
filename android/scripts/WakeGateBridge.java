import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.json.*;
import kr.shiftcalendar.voice.WakeAudioGate;
import kr.shiftcalendar.voice.WakeGrammar;

/** Feeds real PCM and Vosk JSON through the compiled production Kotlin gate. */
class WakeGateBridge {
    static final BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    static final PrintWriter output = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
    static void send(JSONObject object) { output.println(object); }
    public static void main(String[] args) throws Exception {
        WakeAudioGate gate = new WakeAudioGate(16000);
        String line;
        while ((line = input.readLine()) != null) {
            JSONObject value = new JSONObject(line);
            if (value.has("grammar")) { send(new JSONObject().put("grammar", WakeGrammar.INSTANCE.verification(value.getString("grammar")))); continue; }
            if (value.optBoolean("reset")) { gate = new WakeAudioGate(16000); send(new JSONObject().put("ready", true)); continue; }
            byte[] bytes = Base64.getDecoder().decode(value.getString("pcm"));
            short[] pcm = new short[bytes.length / 2];
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(pcm);
            gate.append(pcm, pcm.length);
            short[] question = gate.questionAudio(value.getJSONObject("result"), value.getBoolean("final"), clip -> {
                ByteBuffer buffer = ByteBuffer.allocate(clip.length * 2).order(ByteOrder.LITTLE_ENDIAN);
                buffer.asShortBuffer().put(clip);
                send(new JSONObject().put("verify", Base64.getEncoder().encodeToString(buffer.array())));
                try { return new JSONObject(input.readLine()); } catch (IOException error) { throw new UncheckedIOException(error); }
            });
            send(new JSONObject().put("detected", question != null).put("questionSamples", question == null ? 0 : question.length));
        }
    }
}
