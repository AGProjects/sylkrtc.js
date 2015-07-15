
NODE_MODULES_DIR = node_modules
DIST_DIR = dist
GULP = $(NODE_MODULES_DIR)/.bin/gulp

.PHONY: all clean min watch

all:
	$(GULP) dist

clean:
	rm -rf $(DIST_DIR)

min:
	$(GULP) --type production

watch:
	$(GULP) watch
