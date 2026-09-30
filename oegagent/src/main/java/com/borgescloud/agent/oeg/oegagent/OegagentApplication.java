package com.borgescloud.agent.oeg.oegagent;

import java.util.List;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import io.github.inference4j.nlp.TextClassification;
import io.github.inference4j.nlp.TextClassifier;

@SpringBootApplication
public class OegagentApplication {

	public static void main(String[] args) {
		SpringApplication.run(OegagentApplication.class, args);
	}

	@RestController
	public class SentimentController {
		private final TextClassifier classifier;

		public SentimentController(TextClassifier classifier) {
			this.classifier = classifier;
		}

		@PostMapping("/analyze")
		public List<TextClassification> analyze(@RequestBody String text) {
			return classifier.classify(text);
		}
	}

}
